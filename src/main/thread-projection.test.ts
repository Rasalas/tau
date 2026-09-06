import { describe, expect, it } from "vitest";
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
