// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, TauDesktopApi, UiToolRun } from "../shared/contracts";
import App from "./App";
import { preferences } from "./preferences";
import { writeCachedTurnActivity } from "./turn-activity";

afterEach(cleanup);

function tool(id: string): UiToolRun {
  return { id, name: "read", args: { path: `${id}.ts` }, status: "done", startedAt: 1, endedAt: 2 };
}

describe("last-turn activity", () => {
  let publish: (event: HostEvent) => void;

  beforeEach(() => {
    localStorage.clear();
    window.tau = {
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }],
        },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard", serviceTierAvailable: false, allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
    } as unknown as TauDesktopApi;
  });

  it("does not unsettle a thread for a recovered run without a new user message", async () => {
    preferences.unsettle("session");
    preferences.toggleSettled("session");
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "agent-status", sessionId: "session", running: false });
    });
    expect(preferences.isSettled("session")).toBe(true);

    act(() => publish({
      type: "user-message",
      sessionId: "session",
      message: { id: "new-work", role: "user", text: "new work", timestamp: Date.now() },
    }));
    expect(preferences.isSettled("session")).toBe(false);
  });

  it("prefers authoritative completed tools over stale running cache entries", async () => {
    writeCachedTurnActivity(localStorage, {
      sessionId: "session",
      baseline: { files: [], added: 0, removed: 0 },
      tools: [{ id: "tool", name: "read", args: {}, status: "running", startedAt: 1 }],
    });
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          turnActivity: {
            tools: [{ id: "tool", name: "read", args: {}, status: "done" as const, startedAt: 1, endedAt: 2 }],
          },
        },
      };
    };

    render(<App />);
    expect(await screen.findByText("Used 1 tool")).toBeTruthy();
    expect(screen.queryByText(/1 running/)).toBeNull();
  });

  it("does not mount virtual rows for tool-only assistant messages", async () => {
    const view = render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => publish({ type: "assistant-start", sessionId: "session", id: "tool-only", timestamp: 1 }));
    expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(0);

    act(() => publish({
      type: "assistant-end",
      sessionId: "session",
      message: { id: "tool-only", role: "assistant", text: "", timestamp: 1 },
    }));
    expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(0);
  });

  it("keeps working activity below a steering message", async () => {
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          isStreaming: true,
          messages: [
            { id: "request", role: "user" as const, text: "Start", timestamp: 1 },
            { id: "partial", role: "assistant" as const, text: "First result", timestamp: 2 },
            { id: "steering", role: "user" as const, text: "fahre bitte fort", timestamp: 3 },
          ],
          turnActivity: {
            anchorMessageId: "request",
            tools: [{ ...tool("one"), status: "running" as const, endedAt: undefined }],
          },
        },
      };
    };

    const view = render(<App />);
    await screen.findByText("fahre bitte fort");

    const rows = Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("Start"),
      expect.stringContaining("First result"),
      expect.stringMatching(/fahre bitte fort.*Working/u),
    ]);
  });

  it("keeps completed tools between the user prompt and the final reply", async () => {
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [{ id: "user", role: "user" as const, text: "Do the work", timestamp: 1 }],
        },
      };
    };
    const view = render(<App />);
    await screen.findByText("Do the work");

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("one") });
      publish({
        type: "assistant-end",
        sessionId: "session",
        message: { id: "assistant", role: "assistant", text: "Finished", timestamp: 2 },
      });
      publish({ type: "agent-status", sessionId: "session", running: false });
    });

    await screen.findByText("Finished");
    const rows = Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/Do the work.*Used 1 tool/u),
      expect.stringContaining("Finished"),
    ]);
  });

  it("keeps changed files in the fixed dock outside the scrolling transcript", async () => {
    writeCachedTurnActivity(localStorage, {
      sessionId: "session",
      baseline: { files: [], added: 0, removed: 0 },
      tools: [],
    });
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [{ id: "user", role: "user" as const, text: "Change the files", timestamp: 1 }],
        },
      };
    };
    window.tau!.getChanges = async () => ({
      files: [{ path: "src/App.tsx", name: "App.tsx", directory: "src", status: "modified", added: 4, removed: 1 }],
      added: 4,
      removed: 1,
    });

    const view = render(<App />);
    await screen.findByText("1 changed file");

    const dock = view.container.querySelector(".conversation-files-dock");
    expect(dock?.textContent).toContain("App.tsx");
    expect(view.container.querySelector(".transcript")?.contains(dock)).toBe(false);
  });

  it("keeps an Enter follow-up visible until the current run can process it", async () => {
    const followUp = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    window.tau!.followUp = followUp;
    window.tau!.steer = steer;
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => publish({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/Queue after this turn/u);
    fireEvent.change(composer, { target: { value: "after this turn" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(followUp).toHaveBeenCalledWith("after this turn", [], "session", expect.any(String)));
    expect(steer).not.toHaveBeenCalled();
    expect(screen.getByTitle("after this turn")).toBeTruthy();
  });

  it("steers with Cmd+Enter and shows the message in the transcript immediately", async () => {
    const steer = vi.fn(async () => undefined);
    window.tau!.followUp = vi.fn(async () => undefined);
    window.tau!.steer = steer;
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => publish({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/Queue after this turn/u);
    fireEvent.change(composer, { target: { value: "use this now" } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });

    await waitFor(() => expect(steer).toHaveBeenCalledWith("use this now", [], "session", expect.any(String)));
    expect(screen.getByText("use this now")).toBeTruthy();
  });

  it("aggregates steering into the current run and resets on the next run", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("one") });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("two"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("two") });
    });
    expect(await screen.findByText(/Working · Used 2 tools/u)).toBeTruthy();

    act(() => {
      publish({ type: "queue", sessionId: "session", steering: ["keep going"], followUp: [] });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("three"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("three") });
    });
    expect(await screen.findByText(/Working · Used 3 tools/u)).toBeTruthy();

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: false });
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("four"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("four") });
    });
    await waitFor(() => expect(screen.queryByText(/Used 3 tools/u)).toBeNull());
    expect(screen.getByText(/Working · Used 1 tool/u)).toBeTruthy();
  });
});
