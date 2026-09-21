// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PanelProps, StageTabHandle } from "tau";
import { TerminalPanel, placeOf } from "./panel.js";
import { TerminalStageTab } from "./stage-tab.js";
import { connectTerminalHost, terminalStore } from "./store.js";
import { TERMINAL_LIST_EVENT, TERMINAL_STAGE_TAB, type UiTerminalSession } from "./protocol.js";

// xterm draws on a canvas jsdom does not have; the panel is what is under test.
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; loadAddon() {} open() {} write() {} onData() { return { dispose() {} }; } focus() {} dispose() {} cols = 80; rows = 24; } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

/** A host whose commands the test answers, and whose pushes it sends. */
function fakeHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sessions: UiTerminalSession[] = [];
  const publish = () => listeners.get(TERMINAL_LIST_EVENT)?.forEach((listener) => listener([...sessions]));
  let next = 1;
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    const fields = (input ?? {}) as Record<string, unknown>;
    switch (command) {
      case "list": return [...sessions];
      case "replay": return { data: "", offset: 0 };
      case "open": {
        const session: UiTerminalSession = { id: `t${next++}`, label: `shell ${next - 1}`, cols: 80, rows: 24, cwd: "/project", ...(typeof fields.sessionId === "string" ? { sessionId: fields.sessionId } : {}) };
        sessions.push(session);
        publish();
        return session;
      }
      case "restart": {
        const index = sessions.findIndex((session) => session.id === fields.id);
        const ended = sessions[index];
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
    exit(id: string, exitCode: number) {
      const session = sessions.find((entry) => entry.id === id);
      if (session) session.exitCode = exitCode;
      publish();
    },
  };
}

/** The thread on screen, as the workbench would answer; a test moves it by reassigning. */
let activeSessionId: string | undefined;

function panelProps(actions: Record<string, unknown> = {}): PanelProps {
  return {
    active: true,
    extensionName: "Terminal",
    actions: {
      activeThread: () => ({ sessionId: activeSessionId, workspaceId: "workspace-one", draftPending: false }),
      ...actions,
    } as unknown as PanelProps["actions"],
  };
}

function stageTabHandle(): StageTabHandle {
  return { id: "ext:terminal:t1", setTitle: vi.fn(), setDirty: vi.fn(), onClose: () => () => undefined };
}

afterEach(() => {
  cleanup();
  activeSessionId = undefined;
  terminalStore.setActiveSession(undefined);
  terminalStore.setOnStage("t1", false);
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

  it("shows how a shell ended and restarts it in place", async () => {
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
      expect(screen.getByRole("tab", { name: /shell 1/u }).textContent).not.toContain("exited");
    } finally {
      disconnect();
    }
  });

  it("hands a shell to the stage without ending it, and stands down while it is there", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    const opened: Array<[string, unknown]> = [];
    try {
      render(<TerminalPanel {...panelProps({ openStageTab: (kind: string, params: unknown) => { opened.push([kind, params]); return "ext:terminal:t1"; } })} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });

      fireEvent.click(screen.getByRole("button", { name: "Open shell 1 as tab" }));
      expect(opened).toEqual([[TERMINAL_STAGE_TAB, { id: "t1", label: "shell 1" }]]);

      // The tab takes the view over; the shell itself is never killed.
      render(<TerminalStageTab params={{ id: "t1", label: "shell 1" }} handle={stageTabHandle()} />);
      await waitFor(() => expect(screen.getByText("This shell is open as a stage tab.")).toBeTruthy());
      expect(screen.getByRole("tab", { name: /shell 1/u }).textContent).toContain("on the stage");
      expect(fake.invoke).not.toHaveBeenCalledWith("kill", { id: "t1" });
    } finally {
      disconnect();
    }
  });

  it("closes a terminal and reports a host that refuses", async () => {
    const fake = fakeHost();
    const disconnect = connectTerminalHost(fake.host);
    try {
      render(<TerminalPanel {...panelProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await screen.findByRole("tab", { name: /shell 1/u });
      fireEvent.click(screen.getByRole("button", { name: "Close shell 1" }));
      await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
      expect(screen.getByText("Open a terminal to run commands in this workspace.")).toBeTruthy();

      fake.invoke.mockRejectedValueOnce(new Error("Terminals need node-pty, which this host does not have."));
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      expect((await screen.findByRole("alert")).textContent).toContain("node-pty");
    } finally {
      disconnect();
    }
  });
});
