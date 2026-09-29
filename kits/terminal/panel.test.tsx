// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, StageTab, StageTabHandle, WorkbenchActions } from "tau";
import { TerminalPanel, placeOf } from "./panel.js";
import { TerminalStageTab } from "./stage-tab.js";
import { connectTerminalHost, terminalServices, terminalStore } from "./store.js";
import { addExcerptToPrompt, openTerminalLink, targetShell, toggleTerminal } from "./controller.js";
import { EMPTY_LAYOUT, paneIds, stageGroup } from "./layout.js";
import { pathInside } from "./panes.js";
import { TERMINAL_LIST_EVENT, TERMINAL_PANEL, TERMINAL_STAGE_TAB, type UiTerminalSession } from "./protocol.js";

// xterm draws on a canvas jsdom does not have; the panel is what is under test.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    buffer = { active: { getLine: () => undefined } };
    loadAddon() {}
    open() {}
    write(_data: string, done?: () => void) { done?.(); }
    onData() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

/** A host whose commands the test answers, and whose pushes it sends. */
function fakeHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sessions: UiTerminalSession[] = [];
  const foreground = new Map<string, string>();
  const publish = () => listeners.get(TERMINAL_LIST_EVENT)?.forEach((listener) => listener([...sessions]));
  let next = 1;
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    const fields = (input ?? {}) as Record<string, unknown>;
    switch (command) {
      case "list": return [...sessions];
      case "replay": return { data: "", offset: 0 };
      case "font": return { families: [], files: [], problems: [] };
      case "foreground": return foreground.has(String(fields.id)) ? { process: foreground.get(String(fields.id)) } : {};
      case "open": {
        const session: UiTerminalSession = {
          id: `t${next++}`, label: `shell ${next - 1}`, shell: "zsh", cols: 80, rows: 24, cwd: "/project",
          ...(typeof fields.workspaceId === "string" ? { workspaceId: fields.workspaceId } : {}),
          ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}),
        };
        sessions.push(session);
        // The host publishes the list before it answers, as the real one does.
        publish();
        return session;
      }
      case "restart": {
        const index = sessions.findIndex((session) => session.id === fields.id);
        const ended = sessions[index]!;
        const session: UiTerminalSession = { ...ended, id: `t${next++}` };
        delete session.exitCode;
        sessions.splice(index, 1, session);
        publish();
        return session;
      }
      case "kill": {
        sessions.splice(sessions.findIndex((session) => session.id === fields.id), 1);
        publish();
        return undefined;
      }
      default: return undefined;
    }
  });
  const host: HostExtensionClient = {
    invoke,
    onEvent: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => { set.delete(listener); };
    },
  };
  return {
    host,
    invoke,
    foreground,
    /** The shell reported a new directory, as the host passes an OSC 7 report on. */
    cd(id: string, currentCwd: string) {
      const index = sessions.findIndex((entry) => entry.id === id);
      sessions[index] = { ...sessions[index]!, currentCwd };
      publish();
    },
    exit(id: string, exitCode: number) {
      const session = sessions.find((entry) => entry.id === id);
      if (session) session.exitCode = exitCode;
      publish();
    },
  };
}

/** The thread on screen, as the workbench would answer; a test moves it by reassigning. */
let activeSessionId: string | undefined;
let stageTabs: StageTab[] = [];

function workbenchActions(overrides: Record<string, unknown> = {}): WorkbenchActions {
  return {
    activeThread: () => ({ sessionId: activeSessionId, workspaceId: "workspace-one", draftPending: false }),
    stageTabs: () => stageTabs,
    openStageTab: vi.fn((kind: string, params: Record<string, unknown>) => {
      const id = `ext:${kind}:${String(params.id)}`;
      stageTabs = [...stageTabs.filter((tab) => tab.id !== id), { id, kind: "extension", tabKind: kind, params, title: String(params.label), preview: false } as StageTab];
      return id;
    }),
    closeStageTab: vi.fn((id: string) => { stageTabs = stageTabs.filter((tab) => tab.id !== id); }),
    openPanel: vi.fn(),
    toggleDock: vi.fn(),
    openExternal: vi.fn(),
    focusComposer: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  } as unknown as WorkbenchActions;
}

function panelProps(actions = workbenchActions()): PanelProps {
  return { active: true, extensionName: "Terminal", actions };
}

function stageTabHandle(): StageTabHandle & { close(): void } {
  const listeners = new Set<() => void>();
  return {
    id: "ext:terminal:t1",
    setTitle: vi.fn(),
    setDirty: vi.fn(),
    onClose: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: () => listeners.forEach((listener) => listener()),
  };
}

const layout = () => terminalStore.getSnapshot().layout;

/** Picks an entry of the tab bar's More menu, once an open in flight has settled. */
async function moreAction(name: RegExp) {
  const more = screen.getByRole("button", { name: "More terminal actions" }) as HTMLButtonElement;
  await waitFor(() => expect(more.disabled).toBe(false));
  fireEvent.click(more);
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

beforeEach(() => {
  // jsdom has no canvas; the monospace check then keeps the resolved stack.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  activeSessionId = undefined;
  stageTabs = [];
  terminalStore.setActiveSession(undefined);
  terminalStore.updateLayout(() => EMPTY_LAYOUT);
  delete terminalServices.chips;
  delete terminalServices.preview;
  delete terminalServices.workspace;
  delete terminalServices.actions;
});

describe("placeOf", () => {
  it("tells a project terminal from the active thread's and another thread's", () => {
    expect(placeOf({ id: "a", label: "a", cols: 1, rows: 1 }, "s1")).toBe("project");
    expect(placeOf({ id: "a", label: "a", cols: 1, rows: 1, sessionId: "s1" }, "s1")).toBe("thread");
    expect(placeOf({ id: "a", label: "a", cols: 1, rows: 1, sessionId: "s2" }, "s1")).toBe("elsewhere");
  });
});

describe("TerminalPanel", () => {
  it("keeps another thread's shells out of the tabs, running, and shows one here on request", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    activeSessionId = "s1";
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      expect(screen.queryByRole("button", { name: /in other threads/u })).toBeNull();

      // Leaving the thread does not end the shell: it leaves the tabs for one summary at the strip's end.
      activeSessionId = "s2";
      act(() => terminalStore.setActiveSession("s2"));
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.getByText("No terminal in this thread")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "1 shell in other threads" }));
      const menu = screen.getByRole("menu", { name: "Shells in other threads" });
      expect(within(menu).getByText("They stay with their thread. Pick one to show it here.")).toBeTruthy();
      fireEvent.click(within(menu).getByRole("menuitem", { name: /shell 1/u }));
      const tab = await screen.findByRole("tab", { name: /shell 1/u });
      expect(tab.textContent).toContain("other thread");
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });

      // Back in its own thread it is an ordinary tab again.
      activeSessionId = "s1";
      act(() => terminalStore.setActiveSession("s1"));
      expect(screen.getByRole("tab", { name: /shell 1/u }).textContent).not.toContain("other thread");
    } finally {
      disconnect();
    }
  });

  it("draws one row of chrome above a lone shell: tabs, other threads, actions", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    activeSessionId = "s1";
    try {
      const { container } = render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      expect(container.querySelectorAll("header")).toHaveLength(1);
      expect(within(container.querySelector("header")!).getByRole("tablist")).toBeTruthy();
      expect(screen.queryByRole("heading")).toBeNull();

      // A split names its panes: each gets a slim header of its own.
      const split = screen.getByRole("button", { name: "Split right" }) as HTMLButtonElement;
      await waitFor(() => expect(split.disabled).toBe(false));
      fireEvent.click(split);
      await screen.findByRole("tab", { name: /shell 1 \+1/u });
      expect(container.querySelectorAll(".terminal-pane-header")).toHaveLength(2);
    } finally {
      disconnect();
    }
  });

  it("opens a shell as soon as the panel opens for a thread that has none, and only then", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    activeSessionId = "s1";
    try {
      // The host's list is in before the button is pressed.
      await waitFor(() => expect(terminalStore.isKnown()).toBe(true));
      const { rerender } = render(<TerminalPanel {...panelProps()} active={false} />);
      expect(fake.invoke).not.toHaveBeenCalledWith("open", expect.anything());
      rerender(<TerminalPanel {...panelProps()} active />);
      await screen.findByRole("tab", { name: /shell 1/u });
      expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one", sessionId: "s1" });

      // Closing the last shell leaves the panel empty; it does not start another by itself.
      fireEvent.click(screen.getByRole("button", { name: "Close tab shell 1" }));
      await screen.findByText("No terminal in this thread");
      // Pressed again, the button opens the one shell; once there is one, pressing it starts none.
      rerender(<TerminalPanel {...panelProps()} active={false} />);
      rerender(<TerminalPanel {...panelProps()} active />);
      await screen.findByRole("tab", { name: /shell 2/u });
      rerender(<TerminalPanel {...panelProps()} active={false} />);
      rerender(<TerminalPanel {...panelProps()} active />);
      expect(fake.invoke.mock.calls.filter(([command]) => command === "open")).toHaveLength(2);
    } finally {
      disconnect();
    }
  });

  it("splits the focused shell into a second pane of the same tab, in the same place", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    activeSessionId = "s1";
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      // The buttons stay disabled until the open has settled.
      const split = screen.getByRole("button", { name: "Split down" }) as HTMLButtonElement;
      await waitFor(() => expect(split.disabled).toBe(false));

      fireEvent.click(split);
      await waitFor(() => expect(screen.getByRole("tab", { name: /shell 1 \+1/u })).toBeTruthy());
      // One tab with two panes, the new one focused, and no stray tab from the host's list push.
      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(layout().groups[0]!.root).toEqual({ kind: "split", direction: "down", children: [{ kind: "pane", id: "t1" }, { kind: "pane", id: "t2" }] });
      expect(layout().groups[0]!.focused).toBe("t2");
      // The new shell starts where the one it splits is now.
      expect(fake.invoke).toHaveBeenLastCalledWith("open", { workspaceId: "workspace-one", sessionId: "s1", from: "t1" });
      expect(screen.getAllByRole("region").map((pane) => pane.getAttribute("aria-label"))).toEqual(["shell 1", "shell 2"]);
    } finally {
      disconnect();
    }
  });

  it("shows how a shell ended and restarts it in its own pane", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      act(() => fake.exit("t1", 2));
      expect(screen.getByRole("tab", { name: /shell 1/u }).textContent).toContain("exited");
      expect(screen.getByText(/shell exited with 2/u)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Restart shell" }));
      await waitFor(() => expect(fake.invoke).toHaveBeenCalledWith("restart", { id: "t1" }));
      await waitFor(() => expect(screen.queryByText(/shell exited/u)).toBeNull());
      expect(layout().groups.map((group) => paneIds(group.root))).toEqual([["t2"]]);
    } finally {
      disconnect();
    }
  });

  it("hands a shell to the stage without ending it, and takes it back when the tab closes", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      render(<TerminalPanel {...panelProps(actions)} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });

      await moreAction(/Open as a stage tab/u);
      await waitFor(() => expect(actions.openStageTab).toHaveBeenCalledWith(TERMINAL_STAGE_TAB, { id: "t1", label: "shell 1" }));
      await waitFor(() => expect(screen.getByText("Every shell is on the stage.")).toBeTruthy());
      expect(layout().stage).toEqual([{ id: "t1", root: { kind: "pane", id: "t1" }, focused: "t1" }]);

      // The tab draws the shell; closing it gives the shell back, never kills it.
      const handle = stageTabHandle();
      render(<TerminalStageTab params={{ id: "t1", label: "shell 1" }} handle={handle} actions={actions} />);
      act(() => { stageTabs = []; handle.close(); });
      await screen.findByRole("tab", { name: /shell 1/u });
      expect(layout().stage).toEqual([]);
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });
    } finally {
      disconnect();
    }
  });

  it("splits a stage tab like a panel tab, and closes the tab with its last shell", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      const panel = render(<TerminalPanel {...panelProps(actions)} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      await moreAction(/Open as a stage tab/u);
      await waitFor(() => expect(layout().stage.map((group) => group.id)).toEqual(["t1"]));
      panel.unmount();

      const handle = stageTabHandle();
      const tab = render(<TerminalStageTab params={{ id: "t1", label: "shell 1" }} handle={handle} actions={actions} />);
      const split = within(tab.container).getByRole("button", { name: "Split down" }) as HTMLButtonElement;
      fireEvent.click(split);
      await waitFor(() => expect(stageGroup(layout(), "t1")?.root).toEqual({ kind: "split", direction: "down", children: [{ kind: "pane", id: "t1" }, { kind: "pane", id: "t2" }] }));
      // The new shell starts beside the old one, stays on the stage and gets the keyboard; the tab counts it.
      expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one", from: "t1" });
      expect(layout().groups).toEqual([]);
      expect(terminalStore.getSnapshot().focusRequest?.id).toBe("t2");
      await waitFor(() => expect(handle.setTitle).toHaveBeenLastCalledWith("shell 1 +1"));
      expect(within(tab.container).getAllByRole("region").map((pane) => pane.getAttribute("aria-label"))).toEqual(["shell 1", "shell 2"]);
      // A staged pane has nowhere further to go.
      expect(within(tab.container).queryByRole("button", { name: /as tab/u })).toBeNull();

      fireEvent.click(within(tab.container).getByRole("button", { name: "Close shell 1" }));
      await waitFor(() => expect(stageGroup(layout(), "t1")?.root).toEqual({ kind: "pane", id: "t2" }));
      expect(actions.closeStageTab).not.toHaveBeenCalled();
      fireEvent.click(within(tab.container).getByRole("button", { name: "Close shell 2" }));
      await waitFor(() => expect(actions.closeStageTab).toHaveBeenCalledWith(handle.id));
      expect(layout().stage).toEqual([]);
    } finally {
      disconnect();
    }
  });

  it("gives a split stage tab's shells back to the panel as one tab", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      render(<TerminalPanel {...panelProps(actions)} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      await moreAction(/Open as a stage tab/u);
      await waitFor(() => expect(layout().stage).toHaveLength(1));
      const handle = stageTabHandle();
      const tab = render(<TerminalStageTab params={{ id: "t1", label: "shell 1" }} handle={handle} actions={actions} />);
      fireEvent.click(within(tab.container).getByRole("button", { name: "Split right" }));
      await waitFor(() => expect(paneIds(stageGroup(layout(), "t1")!.root)).toEqual(["t1", "t2"]));

      fireEvent.click(within(tab.container).getByRole("button", { name: "Move to panel" }));
      act(() => handle.close());
      expect(layout().stage).toEqual([]);
      expect(layout().groups.map((group) => group.root)).toEqual([{ kind: "split", direction: "right", children: [{ kind: "pane", id: "t1" }, { kind: "pane", id: "t2" }] }]);
      expect(actions.openPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
    } finally {
      disconnect();
    }
  });

  it("resizes a split by dragging or with the arrow keys, and keeps the shares", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}) });
    // jsdom has no PointerEvent; a mouse event with a pointer id stands in.
    const pointerEvents = "PointerEvent" in window;
    if (!pointerEvents) {
      Object.defineProperty(window, "PointerEvent", {
        configurable: true,
        value: class extends MouseEvent {
          readonly pointerId: number;
          constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
        },
      });
    }
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      const split = screen.getByRole("button", { name: "Split right" }) as HTMLButtonElement;
      await waitFor(() => expect(split.disabled).toBe(false));
      fireEvent.click(split);
      const divider = await screen.findByRole("separator", { name: "Resize terminals" });
      expect(divider.getAttribute("aria-orientation")).toBe("vertical");
      const shares = () => { const root = layout().groups[0]!.root; return root.kind === "split" ? root.sizes?.map((share) => Math.round(share * 100)) : undefined; };
      expect(shares()).toBeUndefined();

      fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 200 });
      fireEvent.pointerMove(divider, { pointerId: 1, clientX: 300 });
      // Drawn from a draft while dragging; stored on release.
      expect(shares()).toBeUndefined();
      expect(divider.getAttribute("aria-valuenow")).toBe("75");
      fireEvent.pointerUp(divider, { pointerId: 1, clientX: 300 });
      expect(shares()).toEqual([75, 25]);

      fireEvent.keyDown(divider, { key: "ArrowLeft" });
      expect(shares()).toEqual([70, 30]);
      // Never under the minimum share.
      fireEvent.pointerDown(divider, { pointerId: 2, button: 0, clientX: 280 });
      fireEvent.pointerUp(divider, { pointerId: 2, clientX: 400 });
      expect(shares()).toEqual([90, 10]);
      fireEvent.doubleClick(divider);
      expect(shares()).toEqual([50, 50]);
    } finally {
      if (!pointerEvents) Reflect.deleteProperty(window, "PointerEvent");
      disconnect();
    }
  });

  it("names a shell's pane by the directory it reported, and opens that directory from the project's Open in", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const openInEditor = vi.fn(async () => undefined);
    const followed = { cwd: "/project" };
    terminalServices.workspace = {
      registerThreadRowAccessory: () => () => undefined,
      getSnapshot: () => followed,
      subscribe: () => () => undefined,
      activeEditor: () => ({ id: "zed", name: "Zed" }),
      openInEditor,
    };
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      // A pane alone in its tab has no header: the path is the tab's tooltip, the folder is under More.
      await moreAction(/Open the project in Zed/u);
      expect(openInEditor).toHaveBeenLastCalledWith(undefined);

      act(() => fake.cd("t1", "/project/src/app"));
      expect(screen.getByRole("tab", { name: /shell 1/u }).getAttribute("data-tooltip")).toBe("/project/src/app");
      await moreAction(/Open app in Zed/u);
      expect(openInEditor).toHaveBeenCalledWith("src/app");

      // Outside the project the store follows there is nothing to open.
      act(() => fake.cd("t1", "/tmp"));
      fireEvent.click(screen.getByRole("button", { name: "More terminal actions" }));
      expect(screen.queryByRole("menuitem", { name: /in Zed/u })).toBeNull();
    } finally {
      disconnect();
    }
  });

  it("gives back a shell whose stage tab closed while nothing drew it", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      const view = render(<TerminalPanel {...panelProps(actions)} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      await moreAction(/Open as a stage tab/u);
      await waitFor(() => expect(layout().stage.map((group) => group.id)).toEqual(["t1"]));
      stageTabs = [];
      view.rerender(<TerminalPanel {...panelProps(actions)} />);
      await screen.findByRole("tab", { name: /shell 1/u });
    } finally {
      disconnect();
    }
  });

  it("asks before closing a shell that runs a program, and leaves it when the user says no", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      fake.foreground.set("t1", "top");

      fireEvent.click(screen.getByRole("button", { name: "Close tab shell 1" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledWith("top is still running. Close the terminal anyway?"));
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Close tab shell 1" }));
      await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
      expect(fake.invoke).toHaveBeenCalledWith("kill", { id: "t1" });
      expect(screen.getByText("No terminal in this thread")).toBeTruthy();
    } finally {
      disconnect();
    }
  });

  it("closes an idle shell without asking and reports a host that refuses", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const confirm = vi.spyOn(window, "confirm");
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      fireEvent.click(screen.getByRole("button", { name: "Close tab shell 1" }));
      await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
      expect(confirm).not.toHaveBeenCalled();

      const add = screen.getByRole("button", { name: "New terminal" }) as HTMLButtonElement;
      await waitFor(() => expect(add.disabled).toBe(false));
      fake.invoke.mockRejectedValueOnce(new Error("Terminals need node-pty, which this host does not have."));
      fireEvent.click(add);
      expect((await screen.findByRole("alert")).textContent).toContain("node-pty");
    } finally {
      disconnect();
    }
  });

  it("gives a shell another kit opened a tab of its own", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    try {
      render(<TerminalPanel {...panelProps()} />);
      await act(async () => { await fake.host.invoke("open", { label: "dev server" }); });
      expect(await screen.findByRole("tab", { name: /shell 1/u })).toBeTruthy();
    } finally {
      disconnect();
    }
  });
});

describe("terminal commands", () => {
  it("toggles the panel with mod+j: shows it with a new shell, then from that shell hides the dock", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    const view = document.createElement("div");
    try {
      await toggleTerminal(actions);
      expect(actions.openPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
      expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one" });
      expect(terminalStore.getSnapshot().focusRequest?.id).toBe("t1");

      view.dataset.terminalId = "t1";
      const input = document.createElement("textarea");
      view.append(input);
      document.body.append(view);
      input.focus();
      await toggleTerminal(actions);
      expect(actions.toggleDock).toHaveBeenCalledOnce();
      expect(actions.focusComposer).toHaveBeenCalledOnce();
      // The request the view never took is dropped with the panel.
      expect(terminalStore.getSnapshot().focusRequest).toBeUndefined();
    } finally {
      view.remove();
      disconnect();
    }
  });

  it("hides the terminal wherever it is, dock or drawer, through closePanel when core has it", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const closePanel = vi.fn();
    const actions = workbenchActions({ closePanel });
    const view = document.createElement("div");
    try {
      await toggleTerminal(actions);
      view.dataset.terminalId = "t1";
      const input = document.createElement("textarea");
      view.append(input);
      document.body.append(view);
      input.focus();
      await toggleTerminal(actions);
      expect(closePanel).toHaveBeenCalledWith(TERMINAL_PANEL);
      expect(actions.toggleDock).not.toHaveBeenCalled();
    } finally {
      view.remove();
      disconnect();
    }
  });

  it("brings a staged shell's tab forward instead of opening the panel", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      await toggleTerminal(actions);
      terminalStore.updateLayout((current) => ({ ...current, groups: [], stage: [{ id: "t1", root: { kind: "pane", id: "t1" }, focused: "t1" }] }));
      vi.mocked(actions.openPanel).mockClear();
      await toggleTerminal(actions);
      expect(actions.openStageTab).toHaveBeenCalledWith(TERMINAL_STAGE_TAB, { id: "t1", label: "shell 1" });
      expect(actions.openPanel).not.toHaveBeenCalled();
    } finally {
      disconnect();
    }
  });

  it("from a shell on the stage hands the keyboard to the composer and leaves its tab where it is", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const closePanel = vi.fn();
    const actions = workbenchActions({ closePanel });
    const view = document.createElement("div");
    try {
      await toggleTerminal(actions);
      terminalStore.updateLayout((current) => ({ ...current, groups: [], stage: [{ id: "t1", root: { kind: "pane", id: "t1" }, focused: "t1" }] }));
      view.dataset.terminalId = "t1";
      const input = document.createElement("textarea");
      view.append(input);
      document.body.append(view);
      input.focus();
      await toggleTerminal(actions);
      expect(actions.focusComposer).toHaveBeenCalledOnce();
      expect(closePanel).not.toHaveBeenCalled();
      expect(actions.closeStageTab).not.toHaveBeenCalled();
    } finally {
      view.remove();
      disconnect();
    }
  });

  it("acts on the shell that has the keyboard, else on the panel's focused one", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    const view = document.createElement("div");
    try {
      await toggleTerminal(actions);
      await act(async () => { await fake.host.invoke("open", {}); });
      expect(targetShell()).toBe("t2");
      view.dataset.terminalId = "t1";
      const input = document.createElement("textarea");
      view.append(input);
      document.body.append(view);
      input.focus();
      expect(targetShell()).toBe("t1");
    } finally {
      view.remove();
      disconnect();
    }
  });

  it("hands a selection to the composer as an excerpt naming the shell and its directory", () => {
    const addChip = vi.fn(() => "chip-1");
    const actions = workbenchActions();
    const session: UiTerminalSession = { id: "t1", label: "shell 1", shell: "zsh", cwd: "/project", cols: 80, rows: 24 };
    expect(addExcerptToPrompt(session, "ls", actions)).toBe(false);
    terminalServices.chips = { addChip };
    expect(addExcerptToPrompt(session, "\n$ ls   \nREADME.md  \n\n", actions)).toBe(true);
    expect(addChip).toHaveBeenCalledWith({ kind: "text-excerpt", label: "zsh · 2 lines", payload: { source: "Terminal (zsh in /project)", text: "$ ls\nREADME.md" } });
    expect(actions.focusComposer).toHaveBeenCalled();
    expect(addExcerptToPrompt(session, "   \n ", actions)).toBe(false);
    // Where the shell is now, when it said so.
    addExcerptToPrompt({ ...session, currentCwd: "/project/src" }, "ls", actions);
    expect(addChip).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { source: "Terminal (zsh in /project/src)", text: "ls" } }));
  });

  it("tells a path inside the project from one outside it", () => {
    expect(pathInside("/project", "/project")).toBe("");
    expect(pathInside("/project/", "/project/src/")).toBe("src");
    expect(pathInside("/project", "/project-two/src")).toBeUndefined();
    expect(pathInside("C:\\work", "C:\\work\\src\\app")).toBe("src/app");
    expect(pathInside("/", "/usr/bin")).toBe("usr/bin");
  });

  it("opens a local server in the Preview and every other link in the browser", async () => {
    const open = vi.fn(async () => undefined);
    const actions = workbenchActions();
    await openTerminalLink("http://localhost:3000", actions);
    // Without Preview Kit a local link still opens, in the browser.
    expect(actions.openExternal).toHaveBeenCalledWith("http://localhost:3000/");
    terminalServices.preview = { open };
    await openTerminalLink("http://0.0.0.0:5173/app", actions);
    expect(open).toHaveBeenCalledWith("http://localhost:5173/app", actions);
    await openTerminalLink("https://github.com/owner/repo", actions);
    expect(actions.openExternal).toHaveBeenLastCalledWith("https://github.com/owner/repo");
    open.mockRejectedValueOnce(new Error("no preview here"));
    await openTerminalLink("http://127.0.0.1:8080", actions);
    expect(actions.openExternal).toHaveBeenLastCalledWith("http://127.0.0.1:8080/");
  });
});
