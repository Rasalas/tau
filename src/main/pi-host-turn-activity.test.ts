import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { decodeHostCursor } from "./transcript-cursor.js";
import { detailFromSnapshot, type ThreadDetail } from "../shared/host-protocol.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { cleanThreadTitle, lastTurnActivityFromMessages, modelSupportsImageInput, PiHost, turnActivityHistoryFromMessages } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { readBootstrapCache, writeBootstrapCache } from "../renderer/bootstrap-cache.js";
import { applyTranscriptBundleMerge } from "../renderer/transcript-history-page-state.js";

describe("cleanThreadTitle", () => {
  it("removes Markdown and title-model framing", () => {
    expect(cleanThreadTitle("## **Thread title: `Persist Turn Activity`**\nExtra explanation")).toBe("Persist Turn Activity");
    expect(cleanThreadTitle("Titel: [Sidebar-Namen](https://example.test)."))
      .toBe("Sidebar-Namen");
  });
});

describe("modelSupportsImageInput", () => {
  it("follows the active model input declaration", () => {
    expect(modelSupportsImageInput({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImageInput({ input: ["text"] })).toBe(false);
    expect(modelSupportsImageInput(undefined)).toBe(false);
  });
});

function piPromptThread(session: {
  model: { input?: readonly string[] };
  isStreaming: boolean;
  prompt(text: string, options?: { preflightResult?: (success: boolean) => void }): Promise<unknown>;
}) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId: "session",
    providerSessionId: "session",
    sessionId: "session",
    cwd: "/repo",
    preparePrompt: async (text: string) => ({
      tauThreadId: "session",
      providerSessionId: "session",
      sessionId: "session",
      backendKind: "pi" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: text,
      runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; promptOptions?: unknown }) => {
      await session.prompt(input.text, input.promptOptions as { preflightResult?: (success: boolean) => void });
      return {};
    },
    isStreaming: () => session.isStreaming,
    isIdle: () => !session.isStreaming,
    branchEntries: () => [],
    appendCustomEntry: () => undefined,
  };
  return {
    threadId: "session",
    sessionId: "session",
    cwd: "/repo",
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    backend,
    runtime: { session },
    pendingClientMessageIds: [],
    pendingClientMessageFingerprints: new Map<string, string>(),
    inFlightClientMessageIds: new Set<string>(),
    deferError: () => false,
  };
}

async function adoptPiPromptThread(host: PiHost, session: Parameters<typeof piPromptThread>[0]): Promise<void> {
  const internals = host as unknown as { threads: { adopt(record: unknown): Promise<void> } };
  await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: piPromptThread(session), isolation: "in-process" });
}

describe("PiHost prompt preflight", () => {
  it("resolves after SDK preflight acceptance and reports later run errors", async () => {
    let rejectRun!: (error: Error) => void;
    const run = new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(true);
        await run;
      },
    };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptPiPromptThread(host, session);
    const accepted = vi.fn();
    const prompt = host.prompt("hello", [], "session", accepted);

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith({ accepted: true }));
    await expect(prompt).resolves.toBeUndefined();
    rejectRun(new Error("late runtime failure"));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "late runtime failure", sessionId: "session" })));
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("rejects before acceptance when the SDK preflight is rejected", async () => {
    let rejectRun!: (error: Error) => void;
    const run = new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(false);
        await run;
      },
    };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptPiPromptThread(host, session);
    const preflight = vi.fn();

    await expect(host.prompt("hello", [], "session", preflight)).rejects.toThrow("prompt was rejected before it started");
    expect(preflight).toHaveBeenCalledWith({ accepted: false });
    rejectRun(new Error("late refusal"));
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "late refusal" }));
  });

  it("owns synchronous validation rejection without an unhandled promise", async () => {
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: vi.fn(),
    };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptPiPromptThread(host, session);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(host.prompt("hello", [{ kind: "image", name: "blocked.png", mimeType: "image/png", data: "x", size: 1 }], "session")).rejects.toThrow(/image input/i);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(session.prompt).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("PiHost.generateThreadTitle", () => {
  it("waits for a new thread's active first run before generating its title", async () => {
    let streaming = true;
    let finishRun!: () => void;
    const runFinished = new Promise<void>((resolve) => { finishRun = resolve; });
    const callOrder: string[] = [];
    const session = {
      sessionId: "session",
      get isStreaming() { return streaming; },
      sessionName: undefined as string | undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "Fix automatic titles" }], timestamp: 1 }],
      waitForIdle: async () => {
        callOrder.push("wait");
        await runFinished;
        streaming = false;
      },
      modelRuntime: {
        getModel: () => ({ provider: "provider", id: "model" }),
        completeSimple: async () => {
          callOrder.push("complete");
          return { stopReason: "stop", content: [{ type: "text", text: "Automatic Thread Titles" }] };
        },
      },
      sessionManager: { getBranch: () => [] },
      setSessionName: (title: string) => { session.sessionName = title; },
    };
    const backend = {
      kind: "pi" as const,
      runtimeAdapter: { id: "pi" as const, capabilities: { skillInvocationDialect: "pi" as const } },
      threadId: "session",
      providerSessionId: "session",
      sessionId: "session",
      cwd: "/repo",
      isStreaming: () => session.isStreaming,
      isIdle: () => !session.isStreaming,
      waitForIdle: session.waitForIdle,
      sessionName: () => session.sessionName,
      transcript: async () => [{ id: "user", role: "user" as const, text: "Fix automatic titles", timestamp: 1 }],
      completeTitle: async () => session.modelRuntime.completeSimple().then((result) => result.content[0].text),
      setTitle: async (title: string) => { session.setSessionName(title); },
      // The title path does not use the remaining backend operations; these
      // stubs keep this test's runtime-owner seam explicit and typed enough for
      // the host's registry fixture.
      detail: async () => ({ title: session.sessionName }),
    };
    const thread = { backend, runtime: { session }, threadId: "session", sessionId: "session", cwd: "/repo" };
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.sessions = [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 }];

    const generated = host.generateThreadTitle("provider", "model", false, "session");
    await Promise.resolve();
    expect(callOrder).toEqual(["wait"]);

    finishRun();
    await expect(generated).resolves.toMatchObject({
      updates: [{ type: "thread-shell", update: { sessionId: "session", shell: { title: "Automatic Thread Titles" } } }],
    });
    expect(callOrder).toEqual(["wait", "complete"]);
  });
});

describe("lastTurnActivityFromMessages", () => {
  it("reconstructs completed tools and their transcript anchor", () => {
    const activity = lastTurnActivityFromMessages([
      { role: "user", content: [{ type: "text", text: "older" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "change it" }], timestamp: 3, tauEntryId: "entry-user" },
      { role: "assistant", content: [{ type: "thinking", thinking: "work" }, { type: "toolCall", id: "call", name: "edit", arguments: { path: "/repo/src/a.ts" } }], timestamp: 4 },
      { role: "toolResult", toolCallId: "call", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "finished" }], timestamp: 6 },
    ]);

    expect(activity).toEqual({
      anchorMessageId: "entry-user",
      tools: [{
        id: "call",
        name: "edit",
        args: { path: "/repo/src/a.ts" },
        status: "done",
        output: "done",
        startedAt: 4,
        endedAt: 5,
      }],
    });
  });
});

describe("turnActivityHistoryFromMessages", () => {
  it("keeps completed tool groups anchored to each turn in chronological order", () => {
    const history = turnActivityHistoryFromMessages([
      { role: "user", tauEntryId: "user-1", content: "inspect", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "read-1", toolName: "read", content: "first output", isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 4 },
      { role: "user", tauEntryId: "user-2", content: "change", timestamp: 5 },
      { role: "assistant", content: [{ type: "toolCall", id: "edit-2", name: "edit", arguments: { path: "b.ts" } }], timestamp: 6 },
      { role: "toolResult", toolCallId: "edit-2", toolName: "edit", content: "permission denied", isError: true, timestamp: 7 },
    ]);

    expect(history).toEqual([
      {
        id: "turn-activity-user-1",
        anchorMessageId: "user-1",
        status: "completed",
        tools: [{
          id: "read-1",
          name: "read",
          args: { path: "a.ts" },
          status: "done",
          output: "first output",
          startedAt: 2,
          endedAt: 3,
        }],
      },
      {
        id: "turn-activity-user-2",
        anchorMessageId: "user-2",
        status: "error",
        tools: [{
          id: "edit-2",
          name: "edit",
          args: { path: "b.ts" },
          status: "error",
          output: "permission denied",
          startedAt: 6,
          endedAt: 7,
        }],
      },
    ]);
  });

  it("retains an interrupted running call as an honest historical state", () => {
    expect(turnActivityHistoryFromMessages([
      { role: "user", tauEntryId: "user", content: "run", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "npm test" } }], timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "stopped" }], stopReason: "aborted", timestamp: 3 },
    ])).toMatchObject([{
      id: "turn-activity-user",
      anchorMessageId: "user",
      status: "interrupted",
      tools: [{ id: "call", status: "running" }],
    }]);
  });

  it("classifies an agent-level error even when no tool result was written", () => {
    expect(turnActivityHistoryFromMessages([
      { role: "user", tauEntryId: "user", content: "run", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }], timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error", timestamp: 3 },
    ])).toMatchObject([{
      id: "turn-activity-user",
      status: "error",
      tools: [{ id: "call", status: "running" }],
    }]);
  });
});

describe("Pi bridge transcript projection", () => {
  it("keeps an adapter-paged snapshot intact through detail, cache trim, and merge", () => {
    const sessionId = "bridge-thread";
    const providerCursor = "cursor::provider/opaque?before=0";
    const rawMessages = Array.from({ length: 10 }, (_, turn) => [
      { role: "user", tauEntryId: `user-${turn}`, content: `request ${turn}`, timestamp: turn * 2 },
      { role: "assistant", tauEntryId: `assistant-${turn}`, content: `answer ${turn}`, timestamp: turn * 2 + 1 },
    ]).flat();
    const bridgeSnapshot: PiBridgeSnapshot = {
      sessionId,
      sessionFile: "/tmp/bridge-thread.jsonl",
      cwd: "/repo",
      sessionName: "Bridge transcript",
      messages: rawMessages,
      messagesOffset: 10_000,
      capabilities: { transcriptPaging: true },
      olderCursor: providerCursor,
      historyCompleteness: "has-more",
      isStreaming: false,
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      activeTools: [],
      allTools: [],
      supportsImageInput: false,
    };
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      bridgeSnapshot?: PiBridgeSnapshot;
      bridgeHostSnapshot(): HostSnapshot;
      detailForSnapshot(snapshot: HostSnapshot): ThreadDetail;
    };
    internals.bridgeSnapshot = bridgeSnapshot;

    const projected = internals.bridgeHostSnapshot();
    expect(projected.transcriptWindow).toBe("bounded");
    expect(projected.messages).toHaveLength(20);
    expect(projected.messages.filter((message) => message.role === "user")).toHaveLength(10);
    expect("transcriptMessageIndexes" in projected).toBe(false);
    expect(projected.olderCursor).toBeDefined();
    expect(projected.cursorBoundaries).toEqual([{
      messageId: "user-0",
      cursor: projected.olderCursor,
    }]);
    expect(decodeHostCursor(projected.olderCursor)).toEqual({ kind: "bridge", value: providerCursor });

    // A bridge page is already bounded. detailForSnapshot must preserve the
    // adapter cursor instead of applying the local decimal-index policy.
    const detail = internals.detailForSnapshot(projected);
    expect(detail.messages).toHaveLength(20);
    expect(detail.olderCursor).toBe(projected.olderCursor);
    expect(detail.transcriptWindow).toBe("bounded");

    let persisted: string | null = null;
    const storage = {
      getItem: () => persisted,
      setItem: (_key: string, value: string) => { persisted = value; },
      removeItem: () => { persisted = null; },
    };
    writeBootstrapCache(projected, { projects: [], sessions: [] }, storage);
    const cached = readBootstrapCache(storage);
    expect(cached?.snapshot.messages).toHaveLength(20);
    expect(cached?.snapshot.messages.filter((message) => message.role === "user")).toHaveLength(10);
    expect(cached?.snapshot.olderCursor).toBe(projected.olderCursor);
    expect(detailFromSnapshot(cached!.snapshot).olderCursor).toBe(projected.olderCursor);

    const merged = applyTranscriptBundleMerge(
      { messages: cached!.snapshot.messages, transcriptWindow: cached!.snapshot.transcriptWindow },
      {
        messages: [
          { id: "older-user", role: "user", text: "older request", timestamp: -2 },
          { id: "older-assistant", role: "assistant", text: "older answer", timestamp: -1 },
          cached!.snapshot.messages[0]!,
        ],
        transcriptWindow: "bounded",
      },
      "prepend",
    );
    expect(merged.messages.slice(0, 2).map((message) => message.id)).toEqual(["older-user", "older-assistant"]);
    expect(merged.messages.filter((message) => message.role === "user")).toHaveLength(11);
    expect(merged).not.toHaveProperty("transcriptMessageIndexes");
  });
});
