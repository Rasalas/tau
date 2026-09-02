// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientTurnIdentity, HostEvent, TauDesktopApi, UiToolRun } from "../shared/contracts";
import App from "./App";
import { preferences } from "./preferences";
import { writeCachedTurnActivity } from "./turn-activity";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard", serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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

  it("keeps a settled thread settled when the host replays its existing user message", async () => {
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [{ id: "entry-existing-work", role: "user" as const, text: "existing work", timestamp: 1 }],
        },
      };
    };
    preferences.unsettle("session");
    preferences.toggleSettled("session");
    render(<App />);
    await screen.findByText("existing work");

    act(() => publish({
      type: "user-message",
      sessionId: "session",
      message: { id: "user-1-0", role: "user", text: "existing work", timestamp: 1 },
    }));

    expect(preferences.isSettled("session")).toBe(true);
  });

  it("keeps a tool without a terminal frame visibly interrupted after settling", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({
        type: "tool-start",
        sessionId: "session",
        tool: { ...tool("stalled"), status: "running", endedAt: undefined },
      });
      publish({ type: "agent-status", sessionId: "session", running: false });
    });

    expect(await screen.findByText("1 tool call interrupted")).toBeTruthy();
    expect(screen.getByText("interrupted")).toBeTruthy();
    expect(localStorage.getItem("tau.bootstrap-cache.v6") ?? "").not.toContain('"status":"interrupted"');
  });

  it("does not persist renderer-derived completion when agent status settles", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("settled"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: tool("settled") });
      publish({ type: "tool-start", sessionId: "session", tool: { ...tool("failed"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", sessionId: "session", tool: { ...tool("failed"), status: "error" } });
      publish({ type: "agent-status", sessionId: "session", running: false });
    });

    const bootstrapCache = localStorage.getItem("tau.bootstrap-cache.v6") ?? "";
    expect(bootstrapCache).not.toContain("turn-activity-settled");
    expect(bootstrapCache).not.toContain("turn-activity-failed");
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

    act(() => {
      publish({
        type: "host-update",
        update: {
          version: 1,
          type: "thread-detail",
          detail: {
            sessionId: "session",
            messages: [
              { id: "user", role: "user", text: "Do the work", timestamp: 1 },
              { id: "assistant", role: "assistant", text: "Finished", timestamp: 2 },
            ],
            isStreaming: false,
            activeTools: [],
            turnActivityHistory: [{
              id: "turn-activity-user",
              anchorMessageId: "user",
              status: "completed",
              tools: [tool("one")],
            }],
          },
        },
      });
      publish({ type: "agent-status", sessionId: "session", running: true });
    });
    expect(await screen.findByText("Used 1 tool")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
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
    window.tau!.invokeHostExtension = workspaceHostStub({ getChanges: async () => ({
      files: [{ path: "src/App.tsx", name: "App.tsx", directory: "src", status: "modified", added: 4, removed: 1 }],
      added: 4,
      removed: 1,
    }) });

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

    await waitFor(() => expect(followUp).toHaveBeenCalledWith(
      "after this turn",
      [],
      "session",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
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

    await waitFor(() => expect(steer).toHaveBeenCalledWith(
      "use this now",
      [],
      "session",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
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

  it("renders completed activity at each persisted turn anchor", async () => {
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [
            { id: "user-one", role: "user" as const, text: "first request", timestamp: 1 },
            { id: "reply-one", role: "assistant" as const, text: "first reply", timestamp: 2 },
            { id: "user-two", role: "user" as const, text: "second request", timestamp: 3 },
            { id: "reply-two", role: "assistant" as const, text: "second reply", timestamp: 4 },
          ],
          turnActivityHistory: [
            { id: "turn-activity-user-one", anchorMessageId: "user-one", status: "completed" as const, tools: [tool("first-tool")] },
            { id: "turn-activity-user-two", anchorMessageId: "user-two", status: "error" as const, tools: [{ ...tool("second-tool"), status: "error" as const }] },
          ],
        },
      };
    };

    const view = render(<App />);
    await screen.findByText("second reply");
    const activityRows = view.container.querySelectorAll(".inline-transcript-activity");
    expect(activityRows).toHaveLength(2);
    expect(activityRows[0]?.textContent).not.toContain("Completed");
    expect(activityRows[1]?.textContent).not.toContain("1 failed");
    expect(activityRows[0]?.textContent).toContain("Used 1 tool");
    expect(activityRows[1]?.textContent).toContain("Used 1 tool");
  });

  it("does not duplicate the live group when its anchor is an assistant message", async () => {
    const originalBootstrap = window.tau!.bootstrap;
    window.tau!.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      const currentTool = { ...tool("current"), status: "running" as const, endedAt: undefined };
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          isStreaming: true,
          messages: [
            { id: "user", role: "user" as const, text: "request", timestamp: 1 },
            { id: "assistant", role: "assistant" as const, text: "I will inspect this", timestamp: 2 },
          ],
          turnActivity: { anchorMessageId: "assistant", tools: [currentTool] },
          turnActivityHistory: [{
            id: "turn-activity-user",
            anchorMessageId: "assistant",
            status: "running" as const,
            tools: [currentTool],
          }],
        },
      };
    };

    const view = render(<App />);
    await screen.findByText("I will inspect this");
    expect(view.container.querySelectorAll(".inline-transcript-activity")).toHaveLength(1);
  });
});
