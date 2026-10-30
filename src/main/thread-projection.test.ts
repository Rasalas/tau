import { describe, expect, it, vi } from "vitest";
import { localTranscriptPage } from "./host-transcript.js";
import { hostCursorAtBridgeValue, hostCursorAtLocalIndex } from "./transcript-cursor.js";
import { clientMessageFingerprint, CLIENT_MESSAGE_MARKER } from "../shared/client-message-correlation.js";
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
  it("generates the public tool contract from canonical history and live previews", () => {
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    const thread = externalThread();
    const tool = { id: "private-id", name: "Bash", args: { password: "PRIVATE INPUT" }, status: "running" as const, startedAt: 1 };
    thread.adapterActivity = [{ id: "private-turn", status: "running", tools: [tool] }];
    thread.tools.set(tool.id, { ...tool, output: "Live preview" });
    expect(projection.publicTools(thread, { includeOutput: false })).toEqual({ tools: [{ name: "Bash", status: "running" }], truncated: false });
    expect(projection.publicTools(thread, { includeOutput: true })).toEqual({ tools: [{ name: "Bash", status: "running", output: "Live preview" }], truncated: false });
  });
  it("shows a steer sent while an answer streamed below that answer, as the live view did", () => {
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    const thread = externalThread();
    // The kit stored the steer when it was sent, the answer only when it ended.
    thread.adapterMessages = [
      { id: "u1", role: "user", text: "do it", timestamp: 1 },
      { id: "u2", role: "user", text: "and the tests", timestamp: 5 },
      { id: "a1", role: "assistant", text: "On it.", timestamp: 2 },
    ];
    expect(projection.messages(thread).map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    thread.adapterMessages = thread.adapterMessages.filter((message) => message.id !== "a1");
    thread.liveAssistant = { id: "a1", text: "On", thinking: "", timestamp: 2 };
    expect(projection.messages(thread).map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
  });

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

function piThread(entries: () => readonly unknown[], runtime?: object) {
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
  return new ThreadRuntime(backend as never, runtime as never);
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

describe("ThreadProjection transcript", () => {
  it("retains sanitized public tool activity when a conversation switches to Pi", () => {
    const entries = [
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "current", name: "bash", arguments: {} }], timestamp: 2 } },
      { type: "message", id: "r", message: { role: "toolResult", toolCallId: "current", content: [{ type: "text", text: "Current result" }], timestamp: 3 } },
    ];
    const thread = piThread(() => entries);
    thread.backend.capabilities.conversation = { history: () => [], offset: 0, activity: () => [{
      id: "inherited-turn", status: "completed", tools: [
        { id: "inherited", name: "Bash", status: "done", args: { secret: "PRIVATE" }, startedAt: 1, output: "Previous result" },
        { id: "private", name: "request_secret_file", status: "done", args: {}, startedAt: 1, output: "PRIVATE" },
      ],
    }] };
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    expect(projection.publicTools(thread, { includeOutput: false })).toEqual({ tools: [
      { name: "Bash", status: "done" }, { name: "bash", status: "done" },
    ], truncated: false });
    expect(projection.publicTools(thread, { includeOutput: true })).toEqual({ tools: [
      { name: "Bash", status: "done", output: "Previous result" }, { name: "bash", status: "done", output: "Current result" },
    ], truncated: false });
  });

  it("generates public Pi tools without returning raw branch fields or hidden tool answers", () => {
    const entries = [
      { type: "message", id: "u", message: { role: "user", content: "Hi", timestamp: 1 } },
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "toolCall", id: "t", name: "bash", arguments: { password: "PRIVATE" } }, { type: "toolCall", id: "s", name: "mcp__tau__request_secret_file", arguments: {} }, { type: "toolCall", id: "h", name: "computer_use_window", arguments: {} }], timestamp: 2 } },
      { type: "message", id: "r", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "Visible result" }], details: { secret: "PRIVATE" }, timestamp: 3 } },
      { type: "message", id: "s-r", message: { role: "toolResult", toolCallId: "s", toolName: "bash", content: [{ type: "text", text: "PRIVATE SECRET FILE" }], timestamp: 3 } },
      { type: "message", id: "h-r", message: { role: "toolResult", toolCallId: "h", toolName: "read", content: [{ type: "text", text: "PRIVATE HIDDEN RESULT" }], timestamp: 3 } },
    ];
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    const result = projection.publicTools(piThread(() => entries), { includeOutput: true });
    expect(result).toEqual({ tools: [{ name: "bash", status: "done", output: "Visible result" }, { name: "computer_use_window", status: "done" }], truncated: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("recomputes pins after a provider reload while the journal stays unchanged", () => {
    const original = vi.fn(() => ["old-anchor"]);
    const replacement = vi.fn(() => ["new-anchor"]);
    const providers = new Set([original]);
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, providers, () => ({}) as never, () => undefined);
    const thread = piThread(() => [], {});
    const revision = projection.pinsRevision;
    expect([...projection.pinnedEntries(thread)]).toEqual(["old-anchor"]);
    projection.pinnedEntries(thread);
    expect(original).toHaveBeenCalledTimes(1);
    providers.delete(original);
    providers.add(replacement);
    expect(projection.pinsRevision).not.toBe(revision);
    expect([...projection.pinnedEntries(thread)]).toEqual(["new-anchor"]);
    providers.clear();
    expect(projection.hasPinProviders).toBe(false);
    expect([...projection.pinnedEntries(thread)]).toEqual([]);
  });

  it("walks the branch a fixed number of times, however long the thread, when a kit pins entries", () => {
    const reads = (turns: number) => {
      const branch = Array.from({ length: turns }, (_, turn) => [
        { type: "message", id: `u${turn}`, message: { role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: turn * 2 } },
        { type: "message", id: `a${turn}`, message: { role: "assistant", content: [{ type: "text", text: `answer ${turn}` }], timestamp: turn * 2 + 1 } },
      ]).flat();
      const entries = vi.fn(() => branch);
      const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set([() => ["a0"]]), () => ({}) as never, () => undefined);
      // A runtime of its own: only a live Pi thread consults the pin providers.
      const snapshot = projection.hostSnapshot(piThread(entries, {}), [], "/repo", 0);
      expect(snapshot.messages).toHaveLength(turns * 2);
      return entries.mock.calls.length;
    };
    expect(reads(200)).toBe(reads(2));
  });

  it("maps the branch once for a snapshot or a page, not again for its visible messages", () => {
    const branch = [
      { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 } },
      { type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 } },
    ];
    const entries = vi.fn(() => branch);
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => undefined);
    const thread = piThread(entries, {});
    const raw = projection.branchMessages(thread);
    entries.mockClear();
    expect(projection.messages(thread, raw).map((message) => message.text)).toEqual(["question", "answer"]);
    expect(entries).not.toHaveBeenCalled();
    projection.hostSnapshot(thread, [], "/repo", 0);
    expect(entries).toHaveBeenCalledOnce();
  });
});


describe("indexed live transcript pages", () => {
  const make = (branch: { id: string; type: string; message?: unknown }[], ledger = new ClientTurnLedger(), providers = new Set<() => string[]>()) => {
    let current = branch;
    const entries = vi.fn(() => current);
    const thread = piThread(entries, {});
    thread.backend.capabilities.tree = { leafEntryId: () => current.at(-1)?.id } as never;
    const projection = new ThreadProjection(ledger, () => undefined, providers, () => ({}) as never, () => {});
    return { thread, projection, entries, setBranch: (next: typeof branch) => { current = next; } };
  };
  const message = (id: string, role: string, text: string, extra = {}) => ({
    id, type: "message", message: { role, content: [{ type: "text", text }], timestamp: 1, ...extra },
  });

  it("matches the snapshot pager through client markers, pinned replies, wakes, tools and task history", async () => {
    const branch: ReturnType<typeof message>[] = [];
    for (let turn = 0; turn < 45; turn++) {
      branch.push(message(`u${turn}`, "user", turn === 10 ? "[Tau] Finished" : `Ask ${turn}`));
      branch.push(message(`a${turn}`, "assistant", `Answer ${turn}`, {
        content: [{ type: "text", text: `Answer ${turn}` }, { type: "toolCall", id: `tool${turn}`, name: "todo", arguments: {} }],
      }));
      branch.push(message(`t${turn}`, "toolResult", "Done", {
        toolCallId: `tool${turn}`, toolName: "todo",
        details: { action: "create", tasks: [{ id: turn, subject: `Task ${turn}`, status: "completed" }] },
      }));
      branch.push(message(`empty${turn}`, "assistant", ""));
    }
    branch.unshift({ type: "custom", id: "marker", customType: CLIENT_MESSAGE_MARKER,
      data: { clientMessageId: "client0", fingerprint: clientMessageFingerprint("Ask 0") } } as never);
    const f = make(branch, undefined, new Set([() => ["empty0", "empty25"]]));
    const snapshot = f.projection.hostSnapshot(f.thread, [], "/repo", 0);
    let cursor;
    do {
      const expected = localTranscriptPage(f.thread.threadId, snapshot.messages, snapshot.taskHistory, snapshot.turnActivityHistory, true, cursor);
      const page = await f.projection.transcriptPage(f.thread, cursor);
      expect(page).toEqual(expected);
      cursor = page.olderCursor;
    } while (cursor);
    const first = await f.projection.transcriptPage(f.thread, hostCursorAtLocalIndex(2));
    expect(first.messages[0]).toMatchObject({ id: "u0", clientMessageId: "client0" });
  });

  it("rebuilds for appends and equal-length branch changes, and invalidates reloaded pins", async () => {
    const provider = () => ["a"];
    const providers = new Set([provider]);
    const f = make([message("u", "user", "Ask"), message("a", "assistant", "")], undefined, providers);
    expect((await f.projection.transcriptPage(f.thread)).messages.map((m) => m.id)).toEqual(["u", "a"]);
    f.entries.mockClear();
    await f.projection.transcriptPage(f.thread);
    expect(f.entries).not.toHaveBeenCalled();
    providers.delete(provider);
    providers.add(() => []);
    expect((await f.projection.transcriptPage(f.thread)).messages.map((m) => m.id)).toEqual(["u"]);
    f.setBranch([message("u2", "user", "Other branch"), message("a2", "assistant", "Other answer")]);
    expect((await f.projection.transcriptPage(f.thread)).messages.map((m) => m.text)).toEqual(["Other branch", "Other answer"]);
    f.setBranch([message("u2", "user", "Other branch"), message("a2", "assistant", "Other answer"), message("u3", "user", "Continue")]);
    expect((await f.projection.transcriptPage(f.thread)).messages.at(-1)?.text).toBe("Continue");
    await expect(f.projection.transcriptPage(f.thread, hostCursorAtLocalIndex(9))).rejects.toThrow("Invalid transcript cursor");
  });

  it("keeps live text and late client-turn correlation current without walking the branch", async () => {
    const ledger = new ClientTurnLedger();
    const f = make([message("u", "user", "Ask")], ledger);
    await f.projection.transcriptPage(f.thread);
    f.entries.mockClear();
    ledger.remember(f.thread.threadId, { text: "Ask", timestamp: 1, sourceEntryId: "u" }, { clientMessageId: "late", clientTurnId: "late-turn" });
    f.thread.liveAssistant = { id: "live", text: "Partial", thinking: "", timestamp: 2 };
    const first = await f.projection.transcriptPage(f.thread);
    expect(first.messages[0]).toMatchObject({ clientMessageId: "late", clientTurnId: "late-turn" });
    expect(first.messages.at(-1)?.text).toBe("Partial");
    f.thread.liveAssistant.text = "Partial reply";
    expect((await f.projection.transcriptPage(f.thread)).messages.at(-1)?.text).toBe("Partial reply");
    expect(f.entries).not.toHaveBeenCalled();
  });

  it("delegates opaque cursors unchanged to a runtime's paging capability", async () => {
    const f = make([]);
    const cursor = hostCursorAtBridgeValue("sdk-cursor");
    const result = { sessionId: "pi-1", messages: [], hasMore: false };
    const page = vi.fn(async () => result);
    f.thread.backend.capabilities.transcriptPaging = { page } as never;
    expect(await f.projection.transcriptPage(f.thread, cursor)).toBe(result);
    expect(page).toHaveBeenCalledWith(cursor);
    expect(f.entries).not.toHaveBeenCalled();
  });

  it("keeps an external runtime's order, streaming reply and historical tool groups", async () => {
    const thread = externalThread();
    thread.adapterMessages = [
      { id: "u1", role: "user", text: "Ask", timestamp: 1 },
      { id: "u2", role: "user", text: "Steer", timestamp: 3 },
    ];
    thread.liveAssistant = { id: "live", text: "Reply", thinking: "", timestamp: 2 };
    thread.adapterActivity = [{ id: "tools", anchorMessageId: "u1", tools: [], status: "completed" }];
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => {});
    const page = await projection.transcriptPage(thread);
    expect(page.messages.map((m) => m.id)).toEqual(["u1", "live", "u2"]);
    expect(page.turnActivityHistory).toEqual(thread.adapterActivity);
  });
});
