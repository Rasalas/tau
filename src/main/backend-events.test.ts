import { describe, expect, it, vi } from "vitest";
import type { HostEvent, UiMessage, UiToolRun } from "../shared/contracts.js";
import type { HostUpdate } from "../shared/host-protocol.js";
import { handleBackendRuntimeEvent, type BackendEventServices } from "./backend-events.js";
import type { ThreadRuntimeEvent } from "./runtime-types.js";
import { ThreadRuntime } from "./thread-runtime.js";

function makeThread(): ThreadRuntime {
  const backend = {
    kind: "external",
    runtimeAdapter: { id: "external", capabilities: { skillInvocationDialect: "claude-code" } },
    threadId: "thread-1",
    providerSessionId: "provider-1",
    cwd: "/repo",
    turnReporting: "streamed",
    capabilities: {},
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    transcript: async () => [],
  };
  return new ThreadRuntime(backend as never);
}

function makeServices() {
  const events: HostEvent[] = [];
  const updates: HostUpdate[] = [];
  const logs: string[] = [];
  let snapshotStreaming = false;
  const services: BackendEventServices = {
    clientTurns: { settle: vi.fn() } as never,
    emit: (event) => { events.push(event); },
    emitUpdate: (update) => { updates.push(update); },
    log: (label) => { logs.push(label); },
    fail: vi.fn(),
    settledSnapshot: async () => ({ sessionId: "thread-1", isStreaming: snapshotStreaming }) as never,
    detailForSnapshot: (snapshot) => ({ detailOf: snapshot.sessionId }) as never,
    ownTool: vi.fn(),
    releaseTool: vi.fn(),
    pushToolOutput: vi.fn(),
    flushToolOutput: vi.fn(),
    toolEnded: vi.fn(),
    refreshShell: vi.fn(async () => undefined),
  };
  return { services, events, updates, logs, setStreaming: (value: boolean) => { snapshotStreaming = value; } };
}

const user: UiMessage = { id: "u1", role: "user", text: "do it", timestamp: 1, clientMessageId: "m1", clientTurnId: "t1" };
const assistant: UiMessage = { id: "a1", role: "assistant", text: "done", timestamp: 2 };
const tool: UiToolRun = { id: "tool-1", name: "Bash", args: { command: "ls" }, status: "running", startedAt: 5 };

describe("handleBackendRuntimeEvent", () => {
  it("turns a streamed turn into host events and keeps the live state the Pi path keeps", async () => {
    const thread = makeThread();
    const { services, events, updates } = makeServices();
    const run: ThreadRuntimeEvent[] = [
      { type: "turn-started" },
      { type: "user-message", message: user },
      { type: "assistant-start", id: "a1", timestamp: 2 },
      { type: "assistant-thinking", id: "a1", delta: "hm" },
      { type: "assistant-delta", id: "a1", delta: "do" },
      { type: "tool-start", tool },
      { type: "tool-update", id: "tool-1", output: "file" },
      { type: "tool-end", tool: { ...tool, args: {}, status: "done", output: "file.txt", endedAt: 9 } },
      { type: "assistant-delta", id: "a1", delta: "ne" },
      { type: "assistant-end", message: assistant },
      { type: "usage" },
      { type: "turn-settled", status: "completed" },
    ];
    for (const event of run.slice(0, 5)) handleBackendRuntimeEvent(event, thread, services);
    expect(thread.adapterStreaming).toBe(true);
    expect(thread.liveAssistant).toEqual({ id: "a1", text: "do", thinking: "hm", timestamp: 2 });
    expect(thread.adapterMessages).toEqual([user]);

    for (const event of run.slice(5, 8)) handleBackendRuntimeEvent(event, thread, services);
    expect(services.ownTool).toHaveBeenCalledWith("tool-1", "thread-1");
    expect(services.pushToolOutput).toHaveBeenCalledWith("tool-1", "file");
    expect(services.flushToolOutput).toHaveBeenCalledWith("tool-1");
    // The card keeps the arguments and start time of the running card it closes.
    const ended = { ...tool, status: "done", output: "file.txt", endedAt: 9 };
    expect(services.toolEnded).toHaveBeenCalledWith("thread-1", ended, "/repo");
    expect(services.releaseTool).toHaveBeenCalledWith("tool-1");
    expect(thread.tools.size).toBe(0);

    // The turn's fold: anchored at the message before its first tool, closed with the turn.
    expect(thread.adapterActivity).toEqual([{ id: "activity-thread-1-1", anchorMessageId: "u1", tools: [ended], status: "running" }]);

    for (const event of run.slice(8)) handleBackendRuntimeEvent(event, thread, services);
    expect(thread.adapterActivity[0]?.status).toBe("completed");
    expect(thread.adapterMessages).toEqual([user, assistant]);
    expect(thread.liveAssistant).toBeUndefined();
    expect(thread.adapterStreaming).toBe(false);
    expect(services.refreshShell).toHaveBeenCalledWith(thread, false);
    expect(services.clientTurns.settle).toHaveBeenCalledWith("thread-1");

    expect(events.map((event) => event.type)).toEqual([
      "agent-status", "user-message", "assistant-start", "assistant-thinking", "assistant-delta",
      "tool-start", "tool-end", "assistant-delta", "assistant-end", "agent-status",
    ]);
    expect(events.find((event) => event.type === "tool-end")).toEqual({ type: "tool-end", sessionId: "thread-1", tool: ended });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates.map((update) => update.type === "run" ? `run:${update.event}` : update.type)).toEqual(["run:started", "run:settled", "thread-detail"]);
  });

  it("closes the cards of tools still running when a turn is interrupted, and replaces a re-sent row", () => {
    const thread = makeThread();
    const { services, events } = makeServices();
    handleBackendRuntimeEvent({ type: "turn-started" }, thread, services);
    handleBackendRuntimeEvent({ type: "tool-start", tool }, thread, services);
    handleBackendRuntimeEvent({ type: "assistant-end", message: assistant }, thread, services);
    handleBackendRuntimeEvent({ type: "assistant-end", message: { ...assistant, text: "done, really" } }, thread, services);
    handleBackendRuntimeEvent({ type: "turn-settled", status: "interrupted" }, thread, services);
    expect(thread.adapterMessages).toEqual([{ ...assistant, text: "done, really" }]);
    expect(thread.tools.size).toBe(0);
    expect(thread.adapterActivity).toMatchObject([{ status: "interrupted", tools: [{ id: "tool-1", status: "error" }] }]);
    // A turn without tools leaves no fold.
    handleBackendRuntimeEvent({ type: "turn-started" }, thread, services);
    handleBackendRuntimeEvent({ type: "turn-settled", status: "completed" }, thread, services);
    expect(thread.adapterActivity).toHaveLength(1);
    const closed = events.find((event) => event.type === "tool-end");
    expect(closed).toMatchObject({ tool: { id: "tool-1", status: "error", output: "Interrupted." } });
    expect(services.toolEnded).toHaveBeenCalledTimes(1);
  });

  it("forwards notices, queue state, and keeps the snapshot detail off a thread that streams again", async () => {
    const thread = makeThread();
    const { services, events, updates, setStreaming } = makeServices();
    handleBackendRuntimeEvent({ type: "notice", message: "limit reached", level: "warning" }, thread, services);
    handleBackendRuntimeEvent({ type: "queue", steering: ["wait"], followUp: [] }, thread, services);
    setStreaming(true);
    handleBackendRuntimeEvent({ type: "turn-settled", status: "error" }, thread, services);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.slice(0, 2)).toEqual([
      { type: "notice", sessionId: "thread-1", message: "limit reached", level: "warning" },
      { type: "queue", sessionId: "thread-1", steering: ["wait"], followUp: [] },
    ]);
    expect(updates.map((update) => update.type)).toEqual(["run"]);
  });
});
