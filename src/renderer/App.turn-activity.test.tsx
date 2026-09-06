// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { createFakeHostClient, type FakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { writeCachedTurnActivity } from "../workbench/turn-activity";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

function tool(id: string): UiToolRun {
  return { id, name: "read", args: { path: `${id}.ts` }, status: "done", startedAt: 1, endedAt: 2 };
}

describe("last-turn activity", () => {
  let client: FakeHostClient;

  beforeEach(() => {
    client = createFakeHostClient({
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }],
        },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });
    setHostClient(client);
  });

  it("does not unsettle a thread for a recovered run without a new user message", async () => {
    const view = renderApp(client, { seed: ({ preferences }) => { preferences.unsettle("session"); preferences.toggleSettled("session"); } });
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "agent-status", sessionId: "session", running: false });
    });
    expect(view.services.preferences.isSettled("session")).toBe(true);

    act(() => client.emit({
      type: "user-message",
      sessionId: "session",
      message: { id: "new-work", role: "user", text: "new work", timestamp: Date.now() },
    }));
    expect(view.services.preferences.isSettled("session")).toBe(false);
  });

  it("keeps a settled thread settled when the host replays its existing user message", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [{ id: "entry-existing-work", role: "user" as const, text: "existing work", timestamp: 1 }],
        },
      };
    };
    const view = renderApp(client, { seed: ({ preferences }) => { preferences.unsettle("session"); preferences.toggleSettled("session"); } });
    await screen.findByText("existing work");

    act(() => client.emit({
      type: "user-message",
      sessionId: "session",
      message: { id: "user-1-0", role: "user", text: "existing work", timestamp: 1 },
    }));

    expect(view.services.preferences.isSettled("session")).toBe(true);
  });

  it("keeps an uncached settled thread settled when the host replays its existing user message", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        threadIndex: {
          ...bootstrap.threadIndex,
          sessions: [
            ...bootstrap.threadIndex.sessions,
            {
              id: "background-session",
              path: "/background-session.jsonl",
              title: "Settled thread",
              modifiedAt: 2,
              projectPath: "/project",
              projectName: "project",
              messageCount: 2,
            },
          ],
        },
      };
    };
    const view = renderApp(client, { seed: ({ preferences }) => { preferences.unsettle("background-session"); preferences.toggleSettled("background-session"); } });
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => client.emit({
      type: "user-message",
      sessionId: "background-session",
      message: { id: "replayed-user", role: "user", text: "existing work", timestamp: 1 },
    }));

    expect(view.services.preferences.isSettled("background-session")).toBe(true);
  });

  it("keeps a tool without a terminal frame visibly interrupted after settling", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({
        type: "tool-start",
        sessionId: "session",
        tool: { ...tool("stalled"), status: "running", endedAt: undefined },
      });
      client.emit({ type: "agent-status", sessionId: "session", running: false });
    });

    fireEvent.click(await screen.findByRole("button", { name: /Stopped after/u }));
    expect(screen.getByText("interrupted")).toBeTruthy();
    expect(view.storage.get(STORAGE_KEYS.bootstrapCache) ?? "").not.toContain('"status":"interrupted"');
  });

  it("does not persist renderer-derived completion when agent status settles", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("settled"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("settled") });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("failed"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: { ...tool("failed"), status: "error" } });
      client.emit({ type: "agent-status", sessionId: "session", running: false });
    });

    const bootstrapCache = view.storage.get(STORAGE_KEYS.bootstrapCache) ?? "";
    expect(bootstrapCache).not.toContain("turn-activity-settled");
    expect(bootstrapCache).not.toContain("turn-activity-failed");
  });

  it("prefers authoritative completed tools over stale running cache entries", async () => {
    const storage = createMemoryStorage();
    writeCachedTurnActivity(storage, {
      sessionId: "session",
      baseline: { files: [], added: 0, removed: 0 },
      tools: [{ id: "tool", name: "read", args: {}, status: "running", startedAt: 1 }],
    });
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
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

    renderApp(client, { storage });
    expect(await screen.findByRole("button", { name: /Worked for/u })).toBeTruthy();
    expect(screen.queryByText(/1 running/)).toBeNull();
  });

  it("does not mount virtual rows for tool-only assistant messages", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => client.emit({ type: "assistant-start", sessionId: "session", id: "tool-only", timestamp: 1 }));
    expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(0);

    act(() => client.emit({
      type: "assistant-end",
      sessionId: "session",
      message: { id: "tool-only", role: "assistant", text: "", timestamp: 1 },
    }));
    expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(0);
  });

  it("keeps working activity below a steering message", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
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

    const view = renderApp(client);
    await screen.findByText("fahre bitte fort");

    const rows = Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("Start"),
      expect.stringContaining("First result"),
      expect.stringMatching(/fahre bitte fort.*Reading one\.ts/u),
    ]);
  });

  it("keeps completed tools between the user prompt and the final reply", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [{ id: "user", role: "user" as const, text: "Do the work", timestamp: 1 }],
        },
      };
    };
    const view = renderApp(client);
    await screen.findByText("Do the work");

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("one") });
      client.emit({
        type: "assistant-end",
        sessionId: "session",
        message: { id: "assistant", role: "assistant", text: "Finished", timestamp: 2 },
      });
      client.emit({ type: "agent-status", sessionId: "session", running: false });
    });

    await screen.findByText("Finished");
    const rows = Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/Do the work.*Worked for/u),
      expect.stringContaining("Finished"),
    ]);

    act(() => {
      client.emit({
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
      client.emit({ type: "agent-status", sessionId: "session", running: true });
    });
    expect(await screen.findByRole("button", { name: /Worked for/u })).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("holds an Enter follow-up in the workbench queue and sends it once the run settles", async () => {
    const followUp = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => undefined);
    client.followUp = followUp;
    client.steer = steer;
    client.sendPrompt = sendPrompt;
    const view = renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/Queue after this turn/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "after this turn" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("listitem").textContent).toContain("after this turn"));
    expect(composer.value).toBe("");
    // The runtime never holds the follow-up, and it is not a transcript bubble yet.
    expect(followUp).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(view.container.querySelector(".transcript")?.textContent ?? "").not.toContain("after this turn");

    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "after this turn",
      [],
      "session",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    expect(steer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  });

  it("sends only the head of the queue when the run settles and keeps the rest waiting", async () => {
    const sendPrompt = vi.fn(async (..._args: unknown[]) => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.sendPrompt = sendPrompt;
    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/Queue after this turn/u);
    fireEvent.change(composer, { target: { value: "first" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.change(composer, { target: { value: "second" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(sendPrompt.mock.calls[0]?.[0]).toBe("first");
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));
    await waitFor(() => expect(screen.getAllByRole("listitem").map((row) => row.querySelector("span")?.textContent)).toEqual(["second"]));
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]?.[0]).toBe("second");
  });

  it("steers the head of the queue with Cmd+Enter on an empty field or its Steer button", async () => {
    const steer = vi.fn(async () => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.steer = steer;
    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/Queue after this turn/u);
    fireEvent.change(composer, { target: { value: "first" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.change(composer, { target: { value: "second" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() => expect(steer).toHaveBeenCalledWith("first", [], "session", expect.anything(), undefined));
    await waitFor(() => expect(screen.getAllByRole("listitem").map((row) => row.querySelector("span")?.textContent)).toEqual(["second"]));
    expect(screen.getByText("first")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith("second", [], "session", expect.anything(), undefined));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  });

  it("steers with Cmd+Enter and shows the message in the transcript immediately", async () => {
    const steer = vi.fn(async () => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.steer = steer;
    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

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

  it("keeps settled commands with their original turn while the next prompt waits to start", async () => {
    const oldCommand: UiToolRun = {
      id: "old-command",
      name: "bash",
      args: { command: "npm test" },
      status: "done",
      startedAt: 1,
      endedAt: 2,
    };
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          messages: [
            { id: "old-user", role: "user" as const, text: "old request", timestamp: 1 },
            { id: "old-reply", role: "assistant" as const, text: "old reply", timestamp: 2 },
          ],
          turnActivity: { anchorMessageId: "old-user", tools: [oldCommand] },
          turnActivityHistory: [{
            id: "turn-activity-old-user",
            anchorMessageId: "old-user",
            status: "completed" as const,
            tools: [oldCommand],
          }],
        },
      };
    };
    client.sendPrompt = vi.fn(() => new Promise<void>(() => {}));

    renderApp(client);
    await screen.findByText("old reply");
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "new request" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The composer keeps the text until sendPrompt settles (it never does
    // here); wait for the transcript's own paragraph, not the textarea echo.
    const newPrompt = await screen.findByText("new request", { selector: "p" });
    expect(newPrompt).toBeDefined();
    expect(newPrompt?.closest(".virtual-transcript-row")?.textContent).not.toContain("Worked for");
    expect(screen.getByText("old request").closest(".virtual-transcript-row")?.textContent).toContain("Worked for");
  });

  it("aggregates steering into the current run and resets on the next run", async () => {
    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("one") });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("two"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("two") });
    });
    expect(await screen.findByText("Read two.ts")).toBeTruthy();

    act(() => {
      client.emit({ type: "queue", sessionId: "session", steering: ["keep going"], followUp: [] });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("three"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("three") });
    });
    expect(await screen.findByText("Read three.ts")).toBeTruthy();

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: false });
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("four"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("four") });
    });
    await waitFor(() => expect(screen.queryByText("Read three.ts")).toBeNull());
    expect(screen.getByText("Read four.ts")).toBeTruthy();
  });

  it("renders completed activity at each persisted turn anchor", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
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

    const view = renderApp(client);
    await screen.findByText("second reply");
    const activityRows = view.container.querySelectorAll(".inline-transcript-activity");
    expect(activityRows).toHaveLength(2);
    expect(activityRows[0]?.textContent).not.toContain("Completed");
    expect(activityRows[1]?.textContent).not.toContain("1 failed");
    expect(activityRows[0]?.textContent).toContain("Worked for");
    // A turn that failed never folds; it names what it did and says it failed.
    expect(activityRows[1]?.textContent).toContain("Read 1 file");
    expect(activityRows[1]?.querySelector('[aria-label="Activity failed"]')).toBeTruthy();
  });

  it("does not duplicate the live group when its anchor is an assistant message", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
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

    const view = renderApp(client);
    await screen.findByText("I will inspect this");
    expect(view.container.querySelectorAll(".inline-transcript-activity")).toHaveLength(1);
  });
});
