import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { decodeHostCursor } from "./transcript-cursor.js";
import { detailFromSnapshot, type ThreadDetail } from "../shared/host-protocol.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { cleanThreadTitle, lastTurnActivityFromMessages, modelSupportsImageInput, turnActivityHistoryFromMessages } from "./host-messages.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { HostExtensionContext } from "./host-extensions.js";
import { createThreadTitlesHostExtension } from "./extensions/thread-titles-host-extension.js";
import { readBootstrapCache, writeBootstrapCache } from "../renderer/bootstrap-cache.js";
import { applyTranscriptBundleMerge } from "../renderer/transcript-history-page-state.js";
import { TOOL_OUTPUT_READ_PAGE_CHARACTERS } from "../shared/tool-output.js";

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

describe("workspace metadata scope", () => {
  it("canonicalizes and rejects paths outside known projects", async () => {
    const history = {
      list: () => [{ path: "/known", name: "known", lastOpenedAt: 1 }],
      isHidden: () => false,
    };
    // A host extension is the only caller of knownWorkspacePath; a test one shows what it gets back.
    const paths = {
      id: "test.paths",
      name: "Paths",
      activate: (context: HostExtensionContext) => {
        context.registerCommand("canonical", (input) => context.services.knownWorkspacePath((input as { cwd: string }).cwd));
      },
    };
    const host = new PiHost("/known", () => undefined, history as never, false, false, { hostExtensions: [paths] });
    await (host as unknown as { activateHostExtensions(): Promise<void> }).activateHostExtensions();
    await expect(host.invokeHostExtension("test.paths", "canonical", { cwd: "/known/../known" })).resolves.toBe("/known");
    await expect(host.invokeHostExtension("test.paths", "canonical", { cwd: "/not-a-project" })).rejects.toThrow("known Tau project");
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
    branchEntries: (): unknown[] => [],
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

/** Minimal current ThreadRuntime owner used by activation-race tests. */
function makeActivationThread(threadId: string, sessionFile = `/${threadId}.jsonl`) {
  const session = {
    sessionId: threadId,
    sessionFile,
    resourceLoader: { getExtensions: () => ({ extensions: [] }) },
  };
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    sessionId: threadId,
    cwd: "/repo",
    sessionFile: () => sessionFile,
    extensionCount: () => 0,
    composerCommands: () => [],
    branchEntries: () => [],
    hasMessages: () => true,
    isStreaming: () => false,
    isIdle: () => true,
    unbind: () => {},
    abort: async () => {},
    dispose: async () => {},
    preparePrompt: async () => undefined,
  };
  return {
    threadId,
    sessionId: threadId,
    cwd: "/repo",
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    backend,
    runtime: { session },
    pendingClientMessageIds: [],
    pendingClientMessageFingerprints: new Map<string, string>(),
    inFlightClientMessageIds: new Set<string>(),
    adapterPending: 0,
    adapterStreaming: false,
    adapterMessages: [],
    adapterAbortControllers: new Set<AbortController>(),
    releaseEventBarrier: () => {},
    cancelEventBarrier: () => {},
    deferError: () => false,
  } as any;
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

describe("PiHost deliberate tool-output reads", () => {
  it("reads the persisted result instead of the bounded 128 KiB preview", async () => {
    const output = `${"x".repeat(128 * 1024)}\nfinal line`;
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: vi.fn(),
    };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const thread = piPromptThread(session);
    thread.backend.branchEntries = () => [
      { type: "message", id: "user", message: { role: "user", content: "inspect" } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolCallId: "call", content: output, isError: false } },
    ];
    const internals = host as unknown as { threads: { adopt(record: unknown): Promise<void> } };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });

    await expect(host.readToolOutput("session", "call")).resolves.toEqual({
      toolCallId: "call",
      output,
      totalBytes: Buffer.byteLength(output, "utf8"),
      truncated: false,
    });
  });

  it("returns the complete local result beyond eight MiB", async () => {
    const output = `${"x".repeat(8 * 1024 * 1024 + 17)}\nFULL-SUFFIX`;
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: vi.fn(),
    };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const thread = piPromptThread(session);
    thread.backend.branchEntries = () => [
      { type: "message", id: "user", message: { role: "user", content: "inspect" } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolCallId: "call", content: output, isError: false } },
    ];
    const internals = host as unknown as { threads: { adopt(record: unknown): Promise<void> } };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });

    await expect(host.readToolOutput("session", "call")).resolves.toMatchObject({
      toolCallId: "call",
      output,
      totalBytes: Buffer.byteLength(output, "utf8"),
      truncated: false,
    });
  });

  it("assembles a complete bridge result beyond eight MiB", async () => {
    const output = `${"x".repeat(8 * 1024 * 1024 + 17)}\nFULL-SUFFIX`;
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const bridgeCommand = vi.fn(async (command: { command: string; toolCallId: string; offset?: number }) => {
      const offset = command.offset ?? 0;
      const end = Math.min(output.length, offset + TOOL_OUTPUT_READ_PAGE_CHARACTERS);
      return {
        toolCallId: command.toolCallId,
        offset,
        output: output.slice(offset, end),
        totalBytes: Buffer.byteLength(output, "utf8"),
        ...(end < output.length ? { nextOffset: end } : {}),
      };
    });
    const internals = host as unknown as {
      bridge: object;
      bridgeSnapshot: PiBridgeSnapshot;
      bridgeCommand: typeof bridgeCommand;
    };
    internals.bridge = {};
    internals.bridgeSnapshot = { sessionId: "session" } as PiBridgeSnapshot;
    internals.bridgeCommand = bridgeCommand;

    await expect(host.readToolOutput("session", "call")).resolves.toMatchObject({
      toolCallId: "call",
      output,
      totalBytes: Buffer.byteLength(output, "utf8"),
      truncated: false,
    });
    expect(bridgeCommand.mock.calls.length).toBeGreaterThan(1_000);
  });
});

async function titleHost(emit: (event: unknown) => void = () => undefined) {
  const host = new PiHost("/repo", emit as never, {} as never, false, false, { hostExtensions: [createThreadTitlesHostExtension()] });
  await (host as unknown as { activateHostExtensions(): Promise<void> }).activateHostExtensions();
  return host;
}

describe("PiHost.generateThreadTitle", () => {
  it("silently skips automatic title generation until the first message exists", async () => {
    const host = await titleHost();
    const thread = makeActivationThread("session");
    Object.assign(thread.backend, {
      sessionName: () => undefined,
      transcript: async () => [],
    });
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.sessions = [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 0 }];

    await expect(host.invokeHostExtension("tau.thread-titles", "generate", { provider: "provider", modelId: "model", force: false, sessionId: "session" }))
      .resolves.toBeUndefined();
  });

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
    const published: unknown[] = [];
    const host = await titleHost((event) => published.push(event));
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.sessions = [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 }];

    const generated = host.invokeHostExtension("tau.thread-titles", "generate", { provider: "provider", modelId: "model", force: false, sessionId: "session" });
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(["wait"]);

    finishRun();
    await expect(generated).resolves.toEqual({ title: "Automatic Thread Titles" });
    expect(callOrder).toEqual(["wait", "complete"]);
    expect(published).toContainEqual(expect.objectContaining({
      type: "host-update",
      update: expect.objectContaining({ type: "thread-shell", update: { sessionId: "session", shell: expect.objectContaining({ title: "Automatic Thread Titles" }) } }),
    }));
  });

  it("does not let a stale new-thread activation replace a newer live switch", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      beginActivation(): number;
      activateThread(thread: unknown, touch: boolean, epoch: number): Promise<boolean>;
      threads: { adopt(record: unknown): Promise<void>; active?: { runtime: unknown; threadId: string }; setActive(threadId: string): void };
      rememberProject(cwd: string): Promise<void>;
      refreshThreadShell(thread: unknown, touch: boolean): Promise<void>;
      scheduleRuntimePrewarm(): void;
      scheduleSpareThread(cwd: string): void;
    };
    const makeThread = (threadId: string) => makeActivationThread(threadId);
    const staleThread = makeThread("new-thread");
    const liveThread = makeThread("live-thread");
    await internals.threads.adopt({ threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    internals.rememberProject = async () => {
      if (internals.threads.active?.runtime === staleThread) {
        staleEntered();
        await staleGate;
      }
    };
    internals.refreshThreadShell = async () => {};
    internals.scheduleRuntimePrewarm = () => {};
    internals.scheduleSpareThread = () => {};

    const staleEpoch = internals.beginActivation();
    const staleActivation = internals.activateThread(staleThread, true, staleEpoch);
    await staleStarted;
    const liveEpoch = internals.beginActivation();
    await expect(internals.activateThread(liveThread, false, liveEpoch)).resolves.toBe(true);
    releaseStale();

    await expect(staleActivation).resolves.toBe(false);
    expect(internals.threads.active?.threadId).toBe("live-thread");
  });

  it("guards the real newSession result when a newer live switch wins", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const staleThread = makeActivationThread("new-thread", "/new.jsonl");
    const liveThread = makeActivationThread("live-thread", "/live.jsonl");
    await internals.threads.adopt({ threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    internals.rememberProject = async () => {
      if (internals.threads.active?.runtime === staleThread) {
        staleEntered();
        await staleGate;
      }
    };
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takeSpareThread = async () => undefined;
    internals.openThread = async () => staleThread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    internals.threads.release = async () => {};

    const staleNewSession = host.newSession("stale prompt", [], "/repo");
    await staleStarted;
    await expect(host.switchSession("/live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseStale();

    // A superseded request reports its rejection so the client stops waiting
    // for a thread that will never be created.
    await expect(staleNewSession).resolves.toEqual({
      version: 1,
      updates: [],
      submission: { accepted: false, message: "A newer request replaced this new thread." },
    });
    expect(internals.threads.active?.threadId).toBe("live-thread");
  });

  it("admits newSession before the lifecycle queue so a later live switch wins", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const staleThread = makeActivationThread("queued-new-thread", "/queued-new.jsonl");
    const liveThread = makeActivationThread("warm-live-thread", "/warm-live.jsonl");
    await internals.threads.adopt({ threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseLifecycle!: () => void;
    internals.lifecycleQueue = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takeSpareThread = async () => undefined;
    internals.openThread = async () => staleThread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    internals.threads.release = async () => {};
    const prompts: string[] = [];
    internals.prompt = async (text: string) => { prompts.push(text); };

    const queuedNewSession = host.newSession("must not be sent", [], "/repo");
    await expect(host.switchSession("/warm-live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseLifecycle();

    await expect(queuedNewSession).resolves.toEqual({
      version: 1,
      updates: [],
      submission: { accepted: false, message: "A newer request replaced this new thread." },
    });
    expect(prompts).toEqual([]);
    expect(internals.threads.active?.threadId).toBe("warm-live-thread");
  });

  it("accepts a new-thread submission after activation without holding the composer for prompt preflight", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    let acceptPrompt!: () => void;
    const preflight = new Promise<void>((resolve) => { acceptPrompt = resolve; });
    internals.prompt = vi.fn(async () => preflight);

    const creation = host.newSession("start the work", [], "/repo");
    await vi.waitFor(() => expect(internals.prompt).toHaveBeenCalledWith(
      "start the work",
      [],
      "new-thread",
      undefined,
      undefined,
    ));
    const outcome = await Promise.race([
      creation.then((result) => "submission" in result
        && (result as { submission?: { accepted?: boolean } }).submission?.accepted
        ? "accepted" as const
        : "rejected" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    acceptPrompt();
    await creation;

    expect(outcome).toBe("accepted");
  });

  it("returns new-thread acceptance while prompt delivery and catalog reads remain blocked", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    let releaseCatalog!: () => void;
    const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    internals.ensureModels = async () => {
      // A real AgentSession can serialize catalog access with prompt delivery.
      // This is the regression seam: acceptance must not await this read at
      // all. The read is allowed to finish later and publish its update.
      await catalog;
      return [];
    };
    internals.activeUpdates = async () => {
      await internals.ensureModels();
      return { version: 1, updates: [] };
    };
    let releasePrompt!: () => void;
    const prompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
    internals.prompt = vi.fn(async () => {
      await prompt;
    });

    const creation = host.newSession("start the work", [], "/repo");
    const outcome = await Promise.race([
      creation.then((result) => (result as { submission?: { accepted?: boolean } }).submission?.accepted
        ? "accepted" as const
        : "rejected" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    expect(outcome).toBe("accepted");
    expect(internals.prompt).toHaveBeenCalledWith("start the work", [], "new-thread", undefined, undefined);
    releaseCatalog();
    releasePrompt();
    await creation;
  });

  it("publishes the accepted thread detail before a blocked catalog read", async () => {
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.snapshotSync = () => ({
      cwd: "/repo",
      threadId: "new-thread",
      providerSessionId: "new-thread",
      sessionId: "new-thread",
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      backendKind: "pi",
      models: [],
      thinkingLevel: "off",
      thinkingLevels: [],
      messages: [],
      isStreaming: true,
      activeTools: [],
      allTools: [],
      composerCommands: [],
      extensionCount: 0,
    });
    let releaseCatalog!: () => void;
    const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    internals.activeUpdates = async () => {
      await catalog;
      return { version: 1, updates: [] };
    };
    internals.prompt = vi.fn(async () => undefined);

    const creation = host.newSession("start the work", [], "/repo");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "host-update",
      update: expect.objectContaining({
        type: "thread-detail",
        detail: expect.objectContaining({ sessionId: "new-thread" }),
      }),
    })));
    expect(((await creation) as unknown as { submission: { accepted: boolean } }).submission.accepted).toBe(true);

    releaseCatalog();
  });

  it("keeps cold thread switching responsive while new-thread preflight is pending", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const newThread = makeActivationThread("new-thread", "/new.jsonl");
    const coldThread = makeActivationThread("cold-thread", "/cold.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => newThread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    let acceptPrompt!: () => void;
    const preflight = new Promise<void>((resolve) => { acceptPrompt = resolve; });
    internals.prompt = vi.fn(async () => preflight);

    const creation = host.newSession("start the work", [], "/repo");
    await vi.waitFor(() => expect(internals.prompt).toHaveBeenCalled());

    internals.sessions = [{
      id: "cold-thread",
      path: "/cold.jsonl",
      title: "Cold thread",
      modifiedAt: 1,
      projectPath: "/repo",
      projectName: "repo",
      messageCount: 1,
    }];
    internals.attachAvailableBridge = async () => false;
    internals.recoverPendingRestoreTransactions = async () => {};
    internals.openThreadForPath = async () => coldThread;
    internals.activateThread = async () => true;

    const switching = host.switchSession("/cold.jsonl");
    const outcome = await Promise.race([
      switching.then(() => "switched" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    acceptPrompt();
    await Promise.all([creation, switching]);

    expect(outcome).toBe("switched");
  });

  it("reconciles a rejected detached new-thread preflight without interrupting the lifecycle", async () => {
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    const rejection = new Error("prompt preflight rejected");
    internals.prompt = vi.fn(async () => { throw rejection; });

    await expect(host.newSession("start the work", [], "/repo", {
      clientTurnId: "turn",
      clientMessageId: "message",
    })).resolves.toMatchObject({ submission: { accepted: true } });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "user-message-failed",
      sessionId: "new-thread",
      clientMessageId: "message",
      message: "prompt preflight rejected",
    })));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("commits detached delivery only after the prompt is accepted", async () => {
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    let acceptPrompt!: () => void;
    const delivery = new Promise<void>((resolve) => { acceptPrompt = resolve; });
    internals.prompt = vi.fn(async () => { await delivery; });

    await expect(host.newSession("start the work", [], "/repo", {
      clientTurnId: "turn",
      clientMessageId: "message",
    })).resolves.toMatchObject({ submission: { accepted: true }, sessionId: "new-thread" });
    // Session allocation is not the commit: the client must still hold its draft.
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "new-thread-delivery-settled" }));

    acceptPrompt();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({
      type: "new-thread-delivery-settled",
      sessionId: "new-thread",
      clientMessageId: "message",
      accepted: true,
    }));
  });

  it("settles an accepted extension command without a user turn or a later failure", async () => {
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    thread.backend.composerCommands = () => [{ name: "extension-command", source: "extension" }];
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.openThread = async () => thread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    // The real prompt() runs here so the marker bookkeeping is exercised.
    thread.backend.prompt = async (options: { promptOptions?: { preflightResult?: (success: boolean) => void } }) => {
      options.promptOptions?.preflightResult?.(true);
    };
    thread.backend.preparePrompt = async (text: string) => ({ runtimeText: text, visibleText: text });
    internals.assertPreparedPrompt = () => {};
    internals.appendClientMessageMarker = () => true;

    await host.newSession("/extension-command", [], "/repo", { clientTurnId: "turn", clientMessageId: "message" });
    // prompt() owns this decision: it is the only place that knows the text the
    // runtime actually resolved.
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({
      type: "prompt-without-user-turn",
      sessionId: "new-thread",
      clientMessageId: "message",
    }));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({
      type: "new-thread-delivery-settled",
      sessionId: "new-thread",
      clientMessageId: "message",
      accepted: true,
    }));

    // agent_settled must not report the cleared marker as a lost user message.
    internals.handleSessionEvent({ type: "agent_settled", messages: [] }, thread, "new-thread", "/repo");
    expect(thread.pendingClientMessageIds).toEqual([]);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "user-message-failed" }));
  });
});

describe("PiHost project index", () => {
  it("keeps linked worktrees of every saved repository out of the project list", async () => {
    const history = {
      list: () => [
        { path: "/repos/alpha", name: "alpha", lastOpenedAt: 4 },
        { path: "/repos/alpha-worktrees/feat", name: "alpha", lastOpenedAt: 3 },
        { path: "/repos/beta", name: "beta", lastOpenedAt: 2 },
        { path: "/repos/beta-worktrees/fix", name: "beta", lastOpenedAt: 1 },
      ],
      isHidden: () => false,
    };
    const worktrees = new Set(["/repos/alpha-worktrees/feat", "/repos/beta-worktrees/fix"]);
    // Workspace Kit reports linked worktrees as nested; this stands in for it.
    const facts = {
      id: "test.facts",
      name: "Facts",
      activate: (context: HostExtensionContext) => { context.services.describeProjects({ nested: async (cwd) => worktrees.has(cwd) }); },
    };
    const host = new PiHost("/repos/alpha", () => undefined, history as never, false, false, { hostExtensions: [facts] });
    const internals = host as unknown as Record<string, any>;
    await internals.activateHostExtensions();

    // Nothing is offered before the checkouts have been classified.
    expect(internals.threadIndexSnapshot().projects).toEqual([]);
    await Promise.all([...internals.nestedClassifications.values()]);

    expect(internals.threadIndexSnapshot().projects.map((project: { path: string }) => project.path))
      .toEqual(["/repos/alpha", "/repos/beta"]);
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
