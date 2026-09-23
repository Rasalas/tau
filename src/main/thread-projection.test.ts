import { describe, expect, it, vi } from "vitest";
import { catalogFromSnapshot } from "../shared/host-protocol.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import { ThreadProjection } from "./thread-projection.js";
import { ThreadRuntime } from "./thread-runtime.js";

function externalThread() {
  const backend = {
    kind: "external",
    runtimeAdapter: { id: "external", capabilities: { skillInvocationDialect: "claude-code", ownsModelSelection: true } },
    threadId: "thread-1",
    providerSessionId: "provider-1",
    cwd: "/repo",
    turnReporting: "streamed",
    capabilities: {},
    state: () => ({ streaming: true, idle: false, hasMessages: true, activeTools: ["Bash"], supportsImageInput: false, extensionCount: 0, title: "Named" }),
    catalogView: () => ({
      model: { provider: "anthropic", id: "claude-opus-5", name: "claude-opus-5" },
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10, costUsd: 0.5, turns: 1 },
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    }),
    composerCommands: () => [],
  };
  return new ThreadRuntime(backend as never);
}

describe("ThreadProjection for a backend without a journal", () => {
  it("projects the backend's catalog, its live turn and its activity history into the snapshot", () => {
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    const thread = externalThread();
    thread.adapterMessages = [{ id: "u1", role: "user", text: "do it", timestamp: 1 }];
    thread.liveAssistant = { id: "a1", text: "work", thinking: "", timestamp: 2 };
    const running = { id: "tool-1", name: "Bash", args: { command: "ls" }, status: "running" as const, startedAt: 3 };
    thread.tools.set("tool-1", { ...running, output: "partial" });
    thread.adapterActivity = [
      { id: "activity-thread-1-1", anchorMessageId: "u0", tools: [{ ...running, id: "tool-0", status: "done", endedAt: 4 }], status: "completed" },
      { id: "activity-thread-1-2", anchorMessageId: "u1", tools: [running], status: "running" },
    ];
    const snapshot = projection.hostSnapshot(thread, [], "/elsewhere", 3);
    expect(snapshot).toMatchObject({
      cwd: "/repo",
      sessionId: "thread-1",
      sessionName: "Named",
      backendKind: "external",
      model: { provider: "anthropic", id: "claude-opus-5" },
      isStreaming: true,
      activeTools: ["Bash"],
      usage: { costUsd: 0.5, turns: 1 },
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
      historyCompleteness: "complete",
      turnActivityHistoryComplete: true,
      supportsImageInput: false,
    });
    // The streaming reply shows to a thread opened mid-turn.
    expect(snapshot.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    // The live turn carries the latest output of a running tool; the history keeps every fold.
    expect(snapshot.turnActivity).toEqual({ anchorMessageId: "u1", tools: [{ ...running, output: "partial" }] });
    expect(snapshot.turnActivityHistory?.map((entry) => entry.id)).toEqual(["activity-thread-1-1", "activity-thread-1-2"]);
  });
});

function piThread(entries: () => readonly unknown[]) {
  const backend = {
    kind: "pi",
    runtimeAdapter: { id: "pi", capabilities: { skillInvocationDialect: "pi", ownsModelSelection: false } },
    threadId: "pi-1",
    providerSessionId: "pi-1",
    cwd: "/repo",
    turnReporting: "streamed",
    capabilities: { journal: { entries, appendCustomEntry: () => undefined, appendMessage: () => undefined } },
    state: () => ({ streaming: false, idle: true, hasMessages: true, activeTools: [], supportsImageInput: true, extensionCount: 7, title: undefined }),
    catalogView: () => ({
      model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      thinkingLevel: "high",
      thinkingLevels: ["low", "high"],
      allTools: [{ name: "bash", description: "Run a command" }],
    }),
    composerCommands: () => [{ name: "review", description: "Review", source: "skill" }],
  };
  return new ThreadRuntime(backend as never);
}

describe("ThreadProjection catalog", () => {
  const projection = () => new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
  const models = [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];

  it("is the catalog the full snapshot carries, for a Pi thread and a backend without a journal", () => {
    const entries = [
      { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } },
      { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 } },
    ];
    for (const thread of [piThread(() => entries), externalThread()]) {
      expect(projection().catalog(thread, models, 3)).toEqual(catalogFromSnapshot(projection().hostSnapshot(thread, models, "/repo", 3)));
    }
  });

  it("does not read the thread's messages", () => {
    const entries = vi.fn(() => { throw new Error("the catalog read the journal"); });
    const catalog = projection().catalog(piThread(entries), models, 3);
    expect(entries).not.toHaveBeenCalled();
    expect(catalog).toMatchObject({ sessionId: "pi-1", thinkingLevel: "high", extensionCount: 3, supportsImageInput: true });
  });
});
