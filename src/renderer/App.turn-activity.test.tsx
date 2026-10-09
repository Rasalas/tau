// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiQueuedPrompt, UiSession, UiToolRun } from "../shared/contracts";
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

/** The host's queue as the workbench sees it: calls change it, and each change arrives as the thread's shell. */
function hostQueue(client: FakeHostClient) {
  const items: UiQueuedPrompt[] = [];
  let next = 0;
  const shell: UiSession = { id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 };
  const publish = (options: { held?: boolean } = {}) => act(() => client.emit({ type: "host-update", update: { version: 1, type: "thread-shell", update: { sessionId: "session", shell: {
    ...shell,
    ...(items.length > 0 ? { queued: items.map(({ id, text, attachments }) => ({ id, text, attachments: attachments.length })) } : {}),
    ...(options.held ? { queueHeld: true } : {}),
  } } } }));
  client.queueMessage = vi.fn(async (_sessionId: string, text: string, attachments: UiQueuedPrompt["attachments"]) => {
    next += 1;
    items.push({ id: `queued-${next}`, text, attachments });
    publish();
    return { id: `queued-${next}` };
  });
  client.takeQueued = vi.fn(async (_sessionId: string, id?: string) => {
    const taken = items.filter((item) => id === undefined || item.id === id);
    for (const item of taken) items.splice(items.indexOf(item), 1);
    publish();
    return taken;
  });
  /** What the host does when the run ends: the head leaves as a prompt. */
  const deliverHead = () => { items.shift(); publish(); };
  return { items, publish, deliverHead };
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
          // A listed message keeps startup on this thread instead of a draft.
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
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
    await screen.findByRole("heading", { name: /do next\?$/ });

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
    await screen.findByRole("heading", { name: /do next\?$/ });

    act(() => client.emit({
      type: "user-message",
      sessionId: "background-session",
      message: { id: "replayed-user", role: "user", text: "existing work", timestamp: 1 },
    }));

    expect(view.services.preferences.isSettled("background-session")).toBe(true);
  });

  it("keeps earlier toolcalls above text that arrives during the run", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => {
      client.emit({ type: "user-message", sessionId: "session", message: { id: "u", role: "user", text: "Inspect", timestamp: 1 } });
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: tool("first") });
      client.emit({ type: "tool-start", sessionId: "session", tool: tool("another") });
    });
    await waitFor(() => expect(view.container.querySelector(".inline-transcript-activity")).toBeTruthy());
    act(() => {
      client.emit({ type: "assistant-start", sessionId: "session", id: "a", timestamp: 3 });
      client.emit({ type: "assistant-delta", sessionId: "session", id: "a", delta: "Found the issue" });
    });
    const text = await screen.findByText("Found the issue");
    await waitFor(() => {
      const activity = view.container.querySelector(".inline-transcript-activity")!;
      expect(activity.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    act(() => client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("second"), startedAt: 4, endedAt: 5 } }));
    await waitFor(() => {
      const activities = view.container.querySelectorAll(".inline-transcript-activity");
      expect(activities).toHaveLength(2);
      const reply = screen.getByText("Found the issue");
      expect(activities[0].compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(reply.compareDocumentPosition(activities[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    // Completed work above the answer now shares the prompt's disclosure;
    // work that arrived after this answer keeps its own visible activity.
    await waitFor(() => expect(view.container.querySelectorAll(".inline-transcript-activity")).toHaveLength(1));
    const completed = view.container.querySelector('.virtual-transcript-row[data-message-id="u"] .work-fold-summary') as HTMLButtonElement;
    expect(completed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(completed);
    const readFiles = await screen.findByText("first.ts, another.ts");
    expect(readFiles.compareDocumentPosition(screen.getByText("Found the issue")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says Thinking whenever the running turn has no live tool row, as T3 Code does", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    const thinking = () => view.container.querySelector(".work-live.thinking");
    const liveTool = () => view.container.querySelector(".work-live.running");
    act(() => {
      client.emit({ type: "user-message", sessionId: "session", message: { id: "u", role: "user", text: "Inspect", timestamp: 1 } });
      client.emit({ type: "agent-status", sessionId: "session", running: true });
    });
    await waitFor(() => expect(thinking()).toBeTruthy());

    // A call takes the line over, and keeps it after it ends until output follows.
    act(() => client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), startedAt: 2, status: "running", endedAt: undefined } }));
    await waitFor(() => expect(liveTool()).toBeTruthy());
    expect(thinking()).toBeNull();
    act(() => client.emit({ type: "tool-end", sessionId: "session", tool: { ...tool("one"), startedAt: 2, endedAt: 3 } }));
    expect(await screen.findByText("Reading one.ts")).toBeTruthy();
    expect(thinking()).toBeNull();

    // Reasoning that streams says Thinking in the message itself, and nothing else does.
    act(() => {
      client.emit({ type: "assistant-start", sessionId: "session", id: "a", timestamp: 4 });
      client.emit({ type: "assistant-thinking", sessionId: "session", id: "a", delta: "Weighing it" });
    });
    await waitFor(() => expect(view.container.querySelector(".message-thinking .work-shine")).toBeTruthy());
    expect(liveTool()).toBeNull();
    expect(thinking()).toBeNull();

    // Once the answer streams, the line below it says Thinking again.
    act(() => client.emit({ type: "assistant-delta", sessionId: "session", id: "a", delta: "Found it" }));
    await waitFor(() => expect(thinking()).toBeTruthy());
    expect(view.container.querySelector(".message-thinking .work-shine")).toBeNull();

    // A failed newest call has its own row; the line falls back to Thinking.
    act(() => client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("two"), startedAt: 5, status: "running", endedAt: undefined } }));
    await waitFor(() => expect(thinking()).toBeNull());
    act(() => client.emit({ type: "tool-end", sessionId: "session", tool: { ...tool("two"), startedAt: 5, endedAt: 6, status: "error" } }));
    await waitFor(() => expect(thinking()).toBeTruthy());
    expect(liveTool()).toBeNull();

    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    await waitFor(() => expect(thinking()).toBeNull());
  });

  it("keeps a tool without a terminal frame visibly interrupted after settling", async () => {
    const view = renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });

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
    await screen.findByRole("heading", { name: /do next\?$/ });

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
    await screen.findByRole("heading", { name: /do next\?$/ });

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

  it("places new work after the reply to a steering message", async () => {
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
            { id: "steering", role: "user" as const, text: "Please test it", timestamp: 3 },
            { id: "reply", role: "assistant" as const, text: "I will test the simulator", timestamp: 4 },
          ],
          turnActivity: {
            anchorMessageId: "request",
            tools: [{ ...tool("simulator"), startedAt: 5, status: "running" as const, endedAt: undefined }],
          },
        },
      };
    };
    const view = renderApp(client);
    await screen.findByText("I will test the simulator");
    await waitFor(() => expect(view.container.querySelector(".work-live")?.textContent).toContain("Reading simulator.ts"));
    const rows = Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent);
    expect(rows.at(-1)).toMatch(/I will test the simulator.*Reading simulator\.ts/u);
  });

  it("does not animate an old running history entry beside the current turn", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return {
        ...bootstrap,
        detail: {
          ...bootstrap.detail,
          isStreaming: true,
          messages: [
            { id: "old-user", role: "user" as const, text: "Old request", timestamp: 1 },
            { id: "old-reply", role: "assistant" as const, text: "Old answer", timestamp: 3 },
            { id: "new-user", role: "user" as const, text: "Continue now", timestamp: 4 },
          ],
          turnActivity: { anchorMessageId: "new-user", tools: [{ ...tool("current"), startedAt: 5, status: "running" as const, endedAt: undefined }] },
          turnActivityHistory: [{ id: "old-turn", anchorMessageId: "old-user", status: "running" as const, tools: [tool("old")] }],
        },
      };
    };
    const view = renderApp(client);
    await screen.findByText("Continue now");
    await waitFor(() => expect([...view.container.querySelectorAll(".work-live")].some((row) => row.textContent?.includes("Reading current.ts"))).toBe(true));
    const live = view.container.querySelectorAll(".work-live.running");
    expect(live).toHaveLength(1);
    expect(live[0]?.textContent).toContain("Reading current.ts");
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

  it("parks an Enter follow-up in the host's queue and draws what the host keeps", async () => {
    const followUp = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => undefined);
    client.followUp = followUp;
    client.sendPrompt = sendPrompt;
    const queue = hostQueue(client);
    const view = renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/queue a follow-up/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "after this turn" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("listitem").textContent).toContain("after this turn"));
    expect(client.queueMessage).toHaveBeenCalledWith("session", "after this turn", [], undefined);
    expect(composer.value).toBe("");
    // Neither the runtime nor the window sends it; the host does when the run ends.
    expect(followUp).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(view.container.querySelector(".transcript .queued-message")?.textContent).toContain("after this turn");
    expect(view.container.querySelector(".transcript .message.user")).toBeNull();

    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    queue.deliverHead();
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("shows a queue the host restored as held", async () => {
    const queue = hostQueue(client);
    renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => client.emit({ type: "user-message", sessionId: "session", message: { id: "u1", role: "user", text: "earlier work", timestamp: 1 } }));
    queue.items.push({ id: "restored", text: "from before the restart", attachments: [] });
    queue.publish({ held: true });
    await waitFor(() => expect(screen.getByRole("listitem").textContent).toContain("Held"));
  });

  it("steers the head of the queue with Cmd+Enter on an empty field or its Send now button", async () => {
    const steer = vi.fn(async () => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.steer = steer;
    hostQueue(client);
    renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/queue a follow-up/u);
    fireEvent.change(composer, { target: { value: "first" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.change(composer, { target: { value: "second" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() => expect(steer).toHaveBeenCalledWith("first", [], "session", expect.anything(), undefined));
    await waitFor(() => expect(screen.getAllByRole("listitem").map((row) => row.querySelector("p")?.textContent)).toEqual(["second"]));
    expect(screen.getByText("first")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith("second", [], "session", expect.anything(), undefined));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  });

  it("returns a queued message to the composer, and Stop returns the whole queue", async () => {
    const sendPrompt = vi.fn(async (..._args: unknown[]) => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.sendPrompt = sendPrompt;
    hostQueue(client);
    renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/queue a follow-up/u) as HTMLTextAreaElement;
    for (const [index, text] of ["first", "second", "third"].entries()) {
      fireEvent.change(composer, { target: { value: text } });
      fireEvent.keyDown(composer, { key: "Enter" });
      await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(index + 1));
    }
    fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button", { name: "Cancel and return to the composer" }));
    await waitFor(() => expect(composer.value).toBe("second"));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
    await waitFor(() => expect(composer.value).toBe("second\n\nfirst\n\nthird"));
    expect(screen.queryByRole("listitem")).toBeNull();
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("steers with Cmd+Enter and shows the message in the transcript immediately", async () => {
    const steer = vi.fn(async () => undefined);
    client.followUp = vi.fn(async () => undefined);
    client.steer = steer;
    renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: true }));

    const composer = screen.getByPlaceholderText(/queue a follow-up/u);
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
    const composer = screen.getByPlaceholderText(/Ask anything/u);
    fireEvent.change(composer, { target: { value: "new request" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // sendPrompt never settles here, but the optimistic transcript row is
    // already visible and the submitted text has left the composer.
    const newPrompt = await screen.findByText("new request", { selector: "p" });
    expect(composer).toHaveProperty("value", "");
    expect(newPrompt).toBeDefined();
    expect(newPrompt?.closest(".virtual-transcript-row")?.textContent).not.toContain("Worked for");
    expect(screen.getByText("old request").closest(".virtual-transcript-row")?.textContent).toContain("Worked for");
  });

  it("aggregates steering into the current run and resets on the next run", async () => {
    renderApp(client);
    await screen.findByRole("heading", { name: /do next\?$/ });

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("one") });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("two"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("two") });
    });
    expect(await screen.findByText("Reading two.ts")).toBeTruthy();

    act(() => {
      client.emit({ type: "queue", sessionId: "session", steering: ["keep going"], followUp: [] });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("three"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("three") });
    });
    expect(await screen.findByText("Reading three.ts")).toBeTruthy();

    act(() => {
      client.emit({ type: "agent-status", sessionId: "session", running: false });
      client.emit({ type: "agent-status", sessionId: "session", running: true });
      client.emit({ type: "tool-start", sessionId: "session", tool: { ...tool("four"), status: "running", endedAt: undefined } });
      client.emit({ type: "tool-end", sessionId: "session", tool: tool("four") });
    });
    await waitFor(() => expect(screen.queryByText("Reading three.ts")).toBeNull());
    expect(screen.getByText("Reading four.ts")).toBeTruthy();
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
    const firstTurn = view.container.querySelector('.virtual-transcript-row[data-message-id="user-one"]')!;
    const secondTurn = view.container.querySelector('.virtual-transcript-row[data-message-id="user-two"]')!;
    expect(firstTurn.textContent).not.toContain("Completed");
    expect(secondTurn.textContent).toContain("1 failed call");
    expect(firstTurn.textContent).toContain("Worked for");
    fireEvent.click(firstTurn.querySelector<HTMLButtonElement>(".work-fold-summary")!);
    await screen.findByText("first-tool.ts");
    expect(firstTurn.contains(screen.getByText("first-tool.ts"))).toBe(true);
    // The successful final answer folds failed calls with the rest of its work.
    expect(secondTurn.textContent).toContain("Worked for");
    expect(secondTurn.querySelector('.work-fold-summary[aria-expanded="false"]')).toBeTruthy();
  });

  it("restores tool batches on either side of an intermediate reply", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return { ...bootstrap, detail: { ...bootstrap.detail,
        messages: [
          { id: "u", role: "user" as const, text: "Inspect", timestamp: 1 },
          { id: "a", role: "assistant" as const, text: "Intermediate reply", timestamp: 3 },
          { id: "final", role: "assistant" as const, text: "Finished", timestamp: 6 },
        ],
        turnActivityHistory: [{ id: "history", anchorMessageId: "u", status: "completed" as const,
          tools: [tool("before"), { ...tool("after"), startedAt: 4, endedAt: 5 }],
        }],
      } };
    };
    renderApp(client);
    await screen.findByText("Finished");
    expect(screen.queryByText("Intermediate reply")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Worked for/u }));
    await screen.findByText("Intermediate reply");
    await waitFor(() => {
      const before = screen.getByText("before.ts");
      const after = screen.getByText("after.ts");
      const reply = screen.getByText("Intermediate reply");
      expect(before.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(reply.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(after.compareDocumentPosition(screen.getByText("Finished")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("folds intermediate replies after a final answer despite recovered tool errors", async () => {
    const originalBootstrap = client.bootstrap;
    client.bootstrap = async () => {
      const bootstrap = await originalBootstrap();
      return { ...bootstrap, detail: { ...bootstrap.detail,
        messages: [
          { id: "u", role: "user" as const, text: "Inspect", timestamp: 1 },
          { id: "a", role: "assistant" as const, text: "The first command failed, retrying", timestamp: 3 },
          { id: "final", role: "assistant" as const, text: "Finished successfully", timestamp: 6 },
        ],
        turnActivityHistory: [{ id: "history", anchorMessageId: "u", status: "error" as const,
          tools: [{ ...tool("before"), status: "error" as const }, { ...tool("after"), startedAt: 4, endedAt: 5 }],
        }],
      } };
    };
    renderApp(client);
    await screen.findByText("Finished successfully");
    await waitFor(() => expect(screen.queryByText("The first command failed, retrying")).toBeNull());
    const fold = await screen.findByRole("button", { name: /Worked for.*1 failed call/u });
    fireEvent.click(fold);
    expect(await screen.findByText("The first command failed, retrying")).toBeTruthy();
    expect(await screen.findByText("before.ts")).toBeTruthy();
    expect(await screen.findByText("after.ts")).toBeTruthy();
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

describe("a failed turn", () => {
  const shell = { id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2 };

  it("ends the transcript with the error and a retry until the host clears it", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      platform: "darwin",
      sendPrompt,
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ ...shell, turnError: "stream disconnected before completion" }],
        },
        detail: {
          sessionId: "session",
          messages: [
            { id: "u1", role: "user" as const, text: "Replay the turn.", timestamp: 1 },
            { id: "a1", role: "assistant" as const, text: "Looking at the stream.", timestamp: 2 },
          ],
          isStreaming: false,
          activeTools: [],
        },
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
    renderApp(client);

    // The composer's bar says why and retries; the transcript keeps no second Retry.
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".composer-notice");
      expect(found?.textContent).toContain("Stopped with an error");
      expect(found?.querySelector("p")?.textContent).toBe("stream disconnected before completion");
      return found!;
    });
    expect(document.querySelector(".transcript .turn-error-line")).toBeNull();
    // Retry sends the failed turn's prompt again.
    fireEvent.click(within(bar).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("Replay the turn.", [], "session", expect.anything(), undefined));

    act(() => client.emit({ type: "host-update", update: { version: 1, type: "thread-shell", update: { sessionId: "session", shell } } }));
    await waitFor(() => expect(document.querySelector(".composer-notice")).toBeNull());
  });
});

describe("a thread a provider limit stopped", () => {
  it("says when the limit resets and continues on request", async () => {
    const resetsAt = Date.now() + 90 * 60_000;
    const resumeLimited = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      platform: "darwin",
      resumeLimited,
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2, limit: { message: "You have hit your usage limit.", resetsAt } }],
        },
        detail: {
          sessionId: "session",
          messages: [{ id: "u1", role: "user" as const, text: "Keep going.", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
        },
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
    renderApp(client);

    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".composer-notice.warn");
      expect(found?.textContent).toContain("Rate limit · resets in 1 h 30 min");
      return found!;
    });
    expect(notice.textContent).toContain("You have hit your usage limit.");
    expect(document.querySelector(".turn-error-line")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Wait" }));
    await waitFor(() => expect(resumeLimited).toHaveBeenCalledWith("session", "reset"));
    // The buttons stay disabled until the host has answered the first request.
    const now = within(notice).getByRole("button", { name: "Resume now" }) as HTMLButtonElement;
    await waitFor(() => expect(now.disabled).toBe(false));
    fireEvent.click(now);
    await waitFor(() => expect(resumeLimited).toHaveBeenCalledWith("session", "now"));
  });
});

describe("a thread whose runtime did not start", () => {
  it("shows the thread under a banner that says why and tries again on request", async () => {
    const switchSession = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const client = createFakeHostClient({
      platform: "darwin",
      switchSession,
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "tau-external:codex:session", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1, runtimeError: "The Codex CLI was not found." }],
        },
        detail: { sessionId: "session", messages: [{ id: "u1", role: "user" as const, text: "Earlier work.", timestamp: 1 }], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
    });
    setHostClient(client);
    renderApp(client);

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("The Codex CLI was not found.");
    expect(screen.getByText("Earlier work.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("tau-external:codex:session"));
  });
});
