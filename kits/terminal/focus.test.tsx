// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, WorkbenchActions } from "tau";
import { TerminalPanel } from "./panel.js";
import { connectTerminalHost, terminalServices, terminalStore } from "./store.js";
import { openTerminal, toggleTerminal } from "./controller.js";
import { EMPTY_LAYOUT, focusPane } from "./layout.js";
import { TERMINAL_LIST_EVENT, TERMINAL_PANEL, type UiTerminalSession } from "./protocol.js";

/** An xterm with a real helper textarea, so focus lands where the real one's would. */
const { FakeTerminal, drawn } = vi.hoisted(() => {
  const views: Array<{ textarea: HTMLTextAreaElement }> = [];
  class Xterm {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = { active: { getLine: () => undefined } };
    textarea = document.createElement("textarea");
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      this.textarea.className = "xterm-helper-textarea";
      views.push(this);
    }
    loadAddon() {}
    open(parent: HTMLElement) { parent.append(this.textarea); }
    write(_data: string, done?: () => void) { done?.(); }
    onData() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    focus() { this.textarea.focus(); }
    dispose() { this.textarea.remove(); }
  }
  return { FakeTerminal: Xterm, drawn: views };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

/** The views' resize observers: calling them is the view being shown. */
const observers: Array<() => void> = [];

function fakeHost(): HostExtensionClient {
  const listeners = new Set<(payload: unknown) => void>();
  const sessions: UiTerminalSession[] = [];
  let next = 1;
  return {
    invoke: vi.fn(async (command: string, input?: unknown) => {
      const fields = (input ?? {}) as Record<string, unknown>;
      if (command === "list") return [...sessions];
      if (command === "replay") return { data: "", offset: 0 };
      if (command === "font") return { families: [], files: [], problems: [] };
      if (command !== "open") return undefined;
      const session: UiTerminalSession = {
        id: `t${next++}`, label: `shell ${next - 1}`, shell: "zsh", cols: 80, rows: 24, cwd: "/project",
        ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
      };
      sessions.push(session);
      listeners.forEach((listener) => listener([...sessions]));
      return session;
    }),
    onEvent: (name, listener) => {
      if (name !== TERMINAL_LIST_EVENT) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

let thread = "s1";

function workbenchActions(): WorkbenchActions {
  return {
    activeThread: () => ({ sessionId: thread, workspaceId: "workspace-one", draftPending: false }),
    stageTabs: () => [],
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    toggleDock: vi.fn(),
    focusComposer: vi.fn(() => composer.focus()),
    notify: vi.fn(),
  } as unknown as WorkbenchActions;
}

let composer: HTMLTextAreaElement;
const shown = () => act(() => { observers.forEach((observer) => observer()); });
const xtermOf = (id: string) => document.querySelector<HTMLElement>(`[data-terminal-id="${id}"] textarea`);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    disconnect() { observers.splice(observers.indexOf(this.callback), 1); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
});

afterEach(() => {
  cleanup();
  composer.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.length = 0;
  drawn.length = 0;
  thread = "s1";
  terminalStore.setActiveSession(undefined);
  terminalStore.updateLayout(() => EMPTY_LAYOUT);
  delete terminalServices.actions;
});

/** The panel drawn on the stage, with the keyboard still in the composer. */
async function panelWithShell(actions: WorkbenchActions) {
  render(<TerminalPanel active extensionName="Terminal" actions={actions} placement="stage" />);
  await act(async () => { await toggleTerminal(actions); });
  await waitFor(() => expect(document.activeElement).toBe(xtermOf("t1")));
}

describe("mod+j and the keyboard", () => {
  it("puts the keyboard in a new shell once its panel host is attached, not before", async () => {
    const disconnect = connectTerminalHost(fakeHost());
    const actions = workbenchActions();
    // The stage attaches a panel's host after the panel drew into it.
    const host = document.createElement("div");
    try {
      render(<TerminalPanel active extensionName="Terminal" actions={actions} placement="stage" />, { container: host });
      await act(async () => { await toggleTerminal(actions); });
      await waitFor(() => expect(xtermOf("t1") ?? host.querySelector("textarea")).toBeTruthy());
      await act(async () => { await Promise.resolve(); });
      expect(document.activeElement).toBe(composer);
      expect(terminalStore.getSnapshot().focusRequest?.id).toBe("t1");

      document.body.append(host);
      shown();
      expect(document.activeElement).toBe(xtermOf("t1"));
      expect(terminalStore.getSnapshot().focusRequest).toBeUndefined();
    } finally {
      host.remove();
      disconnect();
    }
  });

  it("brings a terminal on screen forward from the composer, and hides it from the shell", async () => {
    const disconnect = connectTerminalHost(fakeHost());
    const actions = workbenchActions();
    try {
      await panelWithShell(actions);
      composer.focus();

      await act(async () => { await toggleTerminal(actions); });
      expect(actions.closePanel).not.toHaveBeenCalled();
      expect(actions.openPanel).toHaveBeenLastCalledWith(TERMINAL_PANEL);
      expect(document.activeElement).toBe(xtermOf("t1"));

      await act(async () => { await toggleTerminal(actions); });
      expect(actions.closePanel).toHaveBeenCalledWith(TERMINAL_PANEL);
      expect(document.activeElement).toBe(composer);
    } finally {
      disconnect();
    }
  });

  it("goes back to the pane of a split that had the keyboard last", async () => {
    const disconnect = connectTerminalHost(fakeHost());
    const actions = workbenchActions();
    try {
      await act(async () => { await openTerminal(actions); });
      await act(async () => { await openTerminal(actions, { direction: "right", target: "t1" }); });
      // What a pane's view reports when it gets the keyboard. No views here: the xterm mock misses one of two views loading it together.
      act(() => terminalStore.updateLayout((layout) => focusPane(layout, "t1")));

      await act(async () => { await toggleTerminal(actions); });
      expect(terminalStore.getSnapshot().focusRequest?.id).toBe("t1");
    } finally {
      disconnect();
    }
  });

  it("opens a shell of its own for a thread switched to, and puts the keyboard in it", async () => {
    const disconnect = connectTerminalHost(fakeHost());
    const actions = workbenchActions();
    try {
      await panelWithShell(actions);
      composer.focus();
      thread = "s2";
      act(() => terminalStore.setActiveSession("s2"));

      await act(async () => { await toggleTerminal(actions); });
      await waitFor(() => expect(document.activeElement).toBe(xtermOf("t2")));
      expect(xtermOf("t1")).toBeNull();
    } finally {
      disconnect();
    }
  });
});
