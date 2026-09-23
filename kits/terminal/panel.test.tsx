// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, StageTab, StageTabHandle, WorkbenchActions } from "tau";
import { TerminalPanel, placeOf } from "./panel.js";
import { TerminalStageTab } from "./stage-tab.js";
import { connectTerminalHost, terminalServices, terminalStore } from "./store.js";
import { addExcerptToPrompt, openTerminalLink, toggleTerminal } from "./controller.js";
import { EMPTY_LAYOUT, paneIds } from "./layout.js";
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
  it("opens a terminal for the active thread and marks it when the user moves to another thread", async () => {
    const { host } = fakeHost();
    const disconnect = connectTerminalHost(host);
    activeSessionId = "s1";
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      const tab = await screen.findByRole("tab", { name: /shell 1/u });
      expect(tab.textContent).not.toContain("another thread");
      expect(screen.queryByRole("status")).toBeNull();

      // Leaving the thread does not end the shell; the panel says where it still runs.
      activeSessionId = "s2";
      act(() => terminalStore.setActiveSession("s2"));
      expect(screen.getByRole("tab", { name: /shell 1/u }).textContent).toContain("another thread");
      expect(screen.getByRole("status").textContent).toBe("A shell is still running in another thread.");
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
      expect(fake.invoke).toHaveBeenLastCalledWith("open", { workspaceId: "workspace-one", sessionId: "s1" });
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

      fireEvent.click(screen.getByRole("button", { name: "Open shell 1 as tab" }));
      await waitFor(() => expect(actions.openStageTab).toHaveBeenCalledWith(TERMINAL_STAGE_TAB, { id: "t1", label: "shell 1" }));
      await waitFor(() => expect(screen.getByText("Every shell is on the stage.")).toBeTruthy());
      expect(layout().onStage).toEqual(["t1"]);

      // The tab draws the shell; closing it gives the shell back, never kills it.
      const handle = stageTabHandle();
      render(<TerminalStageTab params={{ id: "t1", label: "shell 1" }} handle={handle} actions={actions} />);
      act(() => { stageTabs = []; handle.close(); });
      await screen.findByRole("tab", { name: /shell 1/u });
      expect(layout().onStage).toEqual([]);
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });
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
      fireEvent.click(screen.getByRole("button", { name: "Open shell 1 as tab" }));
      await waitFor(() => expect(layout().onStage).toEqual(["t1"]));
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

      fireEvent.click(screen.getByRole("button", { name: "Close shell 1" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledWith("top is still running. Close the terminal anyway?"));
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Close tab shell 1" }));
      await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
      expect(fake.invoke).toHaveBeenCalledWith("kill", { id: "t1" });
      expect(screen.getByText("Open a terminal to run commands in this workspace.")).toBeTruthy();
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
      fireEvent.click(screen.getByRole("button", { name: "Close shell 1" }));
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
  it("toggles the panel with mod+j: shows it with a new shell, then hides the dock", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      await toggleTerminal(actions);
      expect(actions.openPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
      expect(fake.invoke).toHaveBeenCalledWith("open", { workspaceId: "workspace-one" });
      expect(terminalStore.getSnapshot().focusRequest?.id).toBe("t1");

      terminalStore.setPanelVisible(true);
      await toggleTerminal(actions);
      expect(actions.toggleDock).toHaveBeenCalledOnce();
      terminalStore.setPanelVisible(false);
    } finally {
      disconnect();
    }
  });

  it("hides the terminal wherever it is, dock or drawer, through closePanel when core has it", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const closePanel = vi.fn();
    const actions = workbenchActions({ closePanel });
    try {
      terminalStore.setPanelVisible(true);
      await toggleTerminal(actions);
      expect(closePanel).toHaveBeenCalledWith(TERMINAL_PANEL);
      expect(actions.toggleDock).not.toHaveBeenCalled();
    } finally {
      terminalStore.setPanelVisible(false);
      disconnect();
    }
  });

  it("brings a staged shell's tab forward instead of opening the panel", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const actions = workbenchActions();
    try {
      await toggleTerminal(actions);
      terminalStore.updateLayout((current) => ({ ...current, groups: [], onStage: ["t1"] }));
      vi.mocked(actions.openPanel).mockClear();
      await toggleTerminal(actions);
      expect(actions.openStageTab).toHaveBeenCalledWith(TERMINAL_STAGE_TAB, { id: "t1", label: "shell 1" });
      expect(actions.openPanel).not.toHaveBeenCalled();
    } finally {
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
