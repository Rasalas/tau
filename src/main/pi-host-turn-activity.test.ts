import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../shared/contracts.js";
import type { PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import { decodeHostCursor } from "./transcript-cursor.js";
import { detailFromSnapshot, type ThreadDetail } from "../shared/host-protocol.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { AgentSession, type PromptOptions } from "@earendil-works/pi-coding-agent";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";
import type { ThreadBackendPromptInput } from "./runtime-types.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { cleanThreadTitle, lastTurnActivityFromMessages, modelSupportsImageInput, turnActivityHistoryFromMessages } from "./host-messages.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { HostExtensionContext, HostTurnObserverSet } from "./host-extensions.js";
import { loadBundledKitHostHalves } from "./bundled-kits.js";
import { readBootstrapCache, writeBootstrapCache } from "../workbench/bootstrap-cache.js";
import { applyTranscriptBundleMerge } from "../workbench/transcript-history-page-state.js";
import { TOOL_OUTPUT_READ_PAGE_CHARACTERS } from "../shared/tool-output.js";
import { adoptThread, setActiveThread, setSessionIndex, attachRuntimeWithBridge, activateHostExtensions, mockInternalMethods, getActiveThreadId, rawInternals } from "./test-support/host-harness.js";

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
    await activateHostExtensions(host);
    await expect(host.invokeHostExtension("test.paths", "canonical", { cwd: "/known/../known" })).resolves.toBe("/known");
    await expect(host.invokeHostExtension("test.paths", "canonical", { cwd: "/not-a-project" })).rejects.toThrow("known Tau project");
  });

  it("accepts a folder an extension admitted, by id, before any thread runs there", async () => {
    const history = { list: () => [{ path: "/known", name: "known", lastOpenedAt: 1 }], isHidden: () => false };
    const worktrees = {
      id: "test.worktrees",
      name: "Worktrees",
      permissions: ["workspace:read" as const, "workspace:write" as const],
      activate: (context: HostExtensionContext) => {
        context.registerCommand("create", () => context.services.admitWorkspace("/worktrees/known-feature"));
        context.registerCommand("found", () => context.services.workspaceRef("/elsewhere"));
        context.registerCommand("canonical", (input) => context.services.knownWorkspacePath((input as { workspace: string }).workspace));
      },
    };
    const host = new PiHost("/known", () => undefined, history as never, false, false, { hostExtensions: [worktrees] });
    await activateHostExtensions(host);
    // A folder the extension only found gets an identity, not admission.
    const found = await host.invokeHostExtension("test.worktrees", "found", {}) as { workspaceId: string };
    await expect(host.invokeHostExtension("test.worktrees", "canonical", { workspace: found.workspaceId })).rejects.toThrow("known Tau project");
    const created = await host.invokeHostExtension("test.worktrees", "create", {}) as { workspaceId: string; displayPath: string };
    expect(created.displayPath).toBe("/worktrees/known-feature");
    await expect(host.invokeHostExtension("test.worktrees", "canonical", { workspace: created.workspaceId })).resolves.toBe("/worktrees/known-feature");
  });
});

function piPromptThread(session: {
  model: { input?: readonly string[] };
  isStreaming: boolean;
  prompt(text: string, options?: PromptOptions): Promise<unknown>;
}, entries: unknown[] = []) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId: "session",
    providerSessionId: "session",
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => entries, appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); }, appendMessage: () => undefined },
    },
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
    prompt: (input: ThreadBackendPromptInput) =>
      PiThreadRuntimeBackend.prototype.prompt.call({ ...backend, session } as never, input),
    state: () => ({
      streaming: session.isStreaming,
      idle: !session.isStreaming,
      hasMessages: entries.length > 0,
      activeTools: [],
      supportsImageInput: session.model.input?.includes("image") === true,
      extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never, { session } as never);
}

async function adoptPiPromptThread(host: PiHost, session: Parameters<typeof piPromptThread>[0]): Promise<void> {
  await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: piPromptThread(session) });
}

/** Minimal current ThreadRuntime owner used by activation-race tests. */
function makeActivationThread(threadId: string, sessionFile = `/${threadId}.jsonl`) {
  const session = {
    sessionId: threadId,
    sessionFile,
    resourceLoader: { getExtensions: () => ({ extensions: [] }) },
  };
  const backend: any = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
      extensions: {
        bind: async () => undefined,
        unbind: () => undefined,
        setLifecycleHooks: () => undefined,
        shortcuts: () => [],
        runShortcut: async () => false,
      },
      completions: { complete: async () => "Test title", modelApi: () => undefined },
    },
    state: () => ({
      streaming: false,
      idle: true,
      hasMessages: true,
      sessionFile,
      activeTools: [],
      supportsImageInput: false,
      extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend, { session } as never) as any;
}

describe("issue 13 real SDK refusal reason", () => {
  // Controlled SDK state, not evidence that compaction caused the phone incident.
  // The installed SDK rejects without invoking the acceptance callback.
  const reason = "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";
  function compactingSdkPrompt(text: string, options?: PromptOptions) {
    return AgentSession.prototype.prompt.call({ _compactionAbortController: new AbortController() } as never, text, options);
  }

  it("establishes the real SDK refusal and callback order without delivering a user message", async () => {
    const order: unknown[] = [];
    await compactingSdkPrompt("text-only follow-up", { preflightResult: (accepted) => order.push(accepted) })
      .catch((error: Error) => order.push(error.message));
    expect(order).toEqual([reason]);
  });

  it("admits one retry through the SDK once the controlled compaction gate clears", async () => {
    const delivered: unknown[] = [];
    const sdkState = {
      _compactionAbortController: new AbortController() as AbortController | undefined,
      isStreaming: false,
      model: { provider: "fixture", id: "fixture", input: ["text"] },
      _extensionRunner: { hasHandlers: () => false, emitBeforeAgentStart: async (_text: string, _images: unknown, systemPromptOptions: unknown) => ({ systemPromptOptions, messages: [] }) },
      _runInputHandlers: async (text: string) => ({ text }),
      _normalizePromptImages: async () => ({ images: [], hints: [] }),
      _preparePromptAndToolLoadout: () => undefined,
      getActiveToolNames: () => [],
      _expandSkillCommand: (text: string) => text,
      promptTemplates: [],
      _flushPendingBashMessages: () => undefined,
      _flushPendingCustomMessages: () => undefined,
      _modelRuntime: { hasConfiguredAuth: () => true },
      _findLastAssistantMessage: () => ({ role: "assistant", stopReason: "stop" }),
      _checkCompaction: async () => undefined,
      _pendingNextTurnMessages: [],
      _baseSystemPromptOptions: { selectedTools: [] },
      agent: { state: { systemPrompt: "fixture" } },
      _runAgentPrompt: async (messages: unknown[]) => { delivered.push(...messages); },
      prompt: (text: string, options?: PromptOptions) =>
        AgentSession.prototype.prompt.call(sdkState as never, text, options),
    };
    const runtime = piPromptThread(sdkState);
    const backendContext = { ...runtime.backend, session: sdkState };
    runtime.backend.prompt = (input: ThreadBackendPromptInput) =>
      PiThreadRuntimeBackend.prototype.prompt.call(backendContext as never, input);
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    await expect(host.prompt("text-only follow-up", [], "session")).rejects.toThrow();
    expect(delivered).toEqual([]);
    sdkState["_compactionAbortController"] = undefined;
    const admitted = vi.fn();
    await expect(host.prompt("text-only follow-up", [], "session", admitted)).resolves.toBeUndefined();
    expect(admitted).toHaveBeenCalledExactlyOnceWith({ accepted: true });
    expect(delivered).toEqual([expect.objectContaining({ role: "user", content: [{ type: "text", text: "text-only follow-up" }] })]);
  });

  it.each([true, false])("preserves the available SDK reason at host admission, journal=%s", async (journal) => {
    const session = { model: { input: ["text"] }, isStreaming: false, prompt: compactingSdkPrompt };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const runtime = piPromptThread(session);
    if (!journal) delete runtime.backend.capabilities.journal;
    const backendContext = { ...runtime.backend, session };
    runtime.backend.prompt = (input: ThreadBackendPromptInput) =>
      PiThreadRuntimeBackend.prototype.prompt.call(backendContext as never, input);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const preflight = vi.fn();
    await expect(host.prompt("text-only follow-up", [], "session", preflight)).rejects.toThrow(reason);
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ accepted: false }));
  });
});

describe("PiHost admission settlement contracts", () => {
  it.each([true, false])("settles bare false and cancels its accounting, journal=%s", async (journal) => {
    let finish!: () => void;
    const run = new Promise<void>((resolve) => { finish = resolve; });
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    if (!journal) {
      delete runtime.backend.capabilities.journal;
      (runtime.backend as { kind: string }).kind = "external";
    }
    runtime.backend.prompt = async (input) => { input.onAdmitted?.(false); await run; return {}; };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const internals = host as unknown as {
      clientTurns: { pendingSize: number };
      turnsInFlight: { list(): unknown[] };
      turnObservers: { cancelled: (...args: unknown[]) => Promise<void>; ended: (...args: unknown[]) => Promise<void> };
    };
    const cancelled = vi.spyOn(internals.turnObservers, "cancelled");
    const ended = vi.spyOn(internals.turnObservers, "ended");
    const identity = { clientTurnId: "refused-turn", clientMessageId: "refused-message" };
    await expect(host.prompt("refused", [], "session", identity)).rejects.toThrow("The prompt was rejected before it started.");
    await vi.waitFor(() => {
      expect(internals.clientTurns.pendingSize).toBe(0);
      expect(internals.turnsInFlight.list()).toEqual([]);
      expect(cancelled).toHaveBeenCalledOnce();
    });
    expect(runtime.pendingClientMessageIds).toEqual([]);
    expect(runtime.inFlightClientMessageIds.size).toBe(0);
    if (journal) expect(runtime.entries).toContainEqual(expect.objectContaining({ customType: "tau-client-message-cancel", data: { clientMessageId: "refused-message" } }));
    finish();
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves synchronous rejection, journal=%s", async (journal) => {
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    if (!journal) delete runtime.backend.capabilities.journal;
    runtime.backend.prompt = () => { throw new Error("synchronous refusal"); };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const callback = vi.fn();
    await expect(host.prompt("follow-up", [], "session", callback)).rejects.toThrow("synchronous refusal");
    expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: false, error: expect.any(Error) });
  });

  it.each(["synchronous", "asynchronous"])("observes rejected failed-turn cleanup after accepted %s failure without blocking admission", async (mode) => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    const originalError = new Error(`${mode} accepted run failure`);
    runtime.backend.prompt = (input) => {
      input.onAdmitted?.(true);
      if (mode === "synchronous") throw originalError;
      return Promise.reject(originalError);
    };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const internals = host as unknown as {
      turnObservers: HostTurnObserverSet;
      turnsInFlight: { list(): unknown[] };
    };
    const ended = vi.fn(() => cleanup);
    const removeObserver = internals.turnObservers.add({ ended });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const callback = vi.fn();
    try {
      // Cleanup is still pending: admission and the original thread failure
      // must not wait for an extension's ended observer.
      await expect(host.prompt("follow-up", [], "session", callback)).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(ended).toHaveBeenCalledExactlyOnceWith("session", expect.any(String), "failed");
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: originalError.message, sessionId: "session" }));
      });
      expect(internals.turnsInFlight.list()).toEqual([]);
      rejectCleanup(new Error("failed-turn observer cleanup rejected"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "failed-turn observer cleanup rejected", sessionId: "session" })));
      expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
      expect(emit.mock.calls.filter(([event]) => event.type === "error")).toHaveLength(2);
    } finally {
      removeObserver();
      process.off("unhandledRejection", unhandled);
    }
  });

  it("defers both accepted-run and cleanup errors through the existing thread barrier", async () => {
    const originalError = new Error("accepted run failed");
    const observerError = new Error("failed-turn observer failed");
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    runtime.backend.prompt = (input) => { input.onAdmitted?.(true); throw originalError; };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const internals = host as unknown as { turnObservers: HostTurnObserverSet };
    const removeObserver = internals.turnObservers.add({ ended: async () => { throw observerError; } });
    runtime.beginEventBarrier();
    try {
      await expect(host.prompt("follow-up", [], "session")).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(emit.mock.calls.filter(([event]) => event.type === "error")).toEqual([]);
      const dispatch = vi.fn();
      runtime.releaseEventBarrier(dispatch, vi.fn(), vi.fn());
      expect(dispatch.mock.calls.map((call) => call[4])).toEqual([originalError, observerError]);
      expect(dispatch.mock.calls.every((call) => call[2] === "session")).toBe(true);
    } finally {
      removeObserver();
      runtime.cancelEventBarrier();
    }
  });

  it.each([true, false])("accepted-then-synchronous-error is only a thread failure, journal=%s", async (journal) => {
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    if (!journal) delete runtime.backend.capabilities.journal;
    runtime.backend.prompt = (input) => { input.onAdmitted?.(true); throw new Error("synchronous run failure"); };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const callback = vi.fn();
    await expect(host.prompt("follow-up", [], "session", callback)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "synchronous run failure", sessionId: "session" })));
    expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
  });

  it.each([true, false])("accepted-then-late-error is only a thread failure, journal=%s", async (journal) => {
    let fail!: (error: Error) => void;
    const run = new Promise<void>((_resolve, reject) => { fail = reject; });
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: async () => undefined });
    if (!journal) delete runtime.backend.capabilities.journal;
    runtime.backend.prompt = async (input) => { input.onAdmitted?.(true); await run; return {}; };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const callback = vi.fn();
    await expect(host.prompt("follow-up", [], "session", callback)).resolves.toBeUndefined();
    fail(new Error("late run failure"));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "late run failure", sessionId: "session" })));
    expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
  });

  it("settles the Pi adapter's rejection without reporting a completed turn", async () => {
    const session = { model: { input: ["text"] }, isStreaming: false, prompt: async () => { throw new Error("The prompt was rejected before it started."); } };
    const runtime = piPromptThread(session);
    runtime.backend.prompt = (input) => PiThreadRuntimeBackend.prototype.prompt.call({ ...runtime.backend, session } as never, input);
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    await expect(host.prompt("follow-up", [], "session")).rejects.toThrow("The prompt was rejected before it started.");
  });

  it("propagates a real SDK input hook refusal through the adapter", async () => {
    const session = { model: { input: ["text"] }, isStreaming: false, prompt: (text: string, options?: PromptOptions) => AgentSession.prototype.prompt.call({
      _runInputHandlers: async () => { throw new Error("Input hook refused this prompt."); },
      isStreaming: false,
    } as never, text, options) };
    const runtime = piPromptThread(session);
    runtime.backend.prompt = (input) => PiThreadRuntimeBackend.prototype.prompt.call({ ...runtime.backend, session } as never, input);
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    await expect(host.prompt("follow-up", [], "session")).rejects.toThrow("Input hook refused this prompt.");
  });

  it("accepts a real SDK input hook's handled prompt without starting an agent run", async () => {
    const session = { model: { input: ["text"] }, isStreaming: false, prompt: (text: string, options?: PromptOptions) => AgentSession.prototype.prompt.call({
      _runInputHandlers: async () => undefined,
      isStreaming: false,
    } as never, text, options) };
    const runtime = piPromptThread(session);
    runtime.backend.prompt = (input) => PiThreadRuntimeBackend.prototype.prompt.call({ ...runtime.backend, session } as never, input);
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const callback = vi.fn();
    await expect(host.prompt("follow-up", [], "session", callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledExactlyOnceWith({ accepted: true });
  });

  it("a cancelled real SDK refusal cannot label the next accepted user message", async () => {
    let refuse = true;
    const runtime = piPromptThread({ model: { input: ["text"] }, isStreaming: false, prompt: (text, options) => {
      if (refuse) return AgentSession.prototype.prompt.call({ _compactionAbortController: new AbortController() } as never, text, options);
      options?.preflightResult?.("started");
      return Promise.resolve();
    } });
    // Use the real Pi adapter, preserving the SDK's rejection reason.
    const session = { prompt: (text: string, options?: PromptOptions) => {
      if (refuse) return AgentSession.prototype.prompt.call({ _compactionAbortController: new AbortController() } as never, text, options);
      options?.preflightResult?.("started");
      return new Promise<void>(() => undefined);
    } };
    runtime.backend.prompt = (input) => PiThreadRuntimeBackend.prototype.prompt.call({ ...runtime.backend, session } as never, input);
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime });
    const internals = host as unknown as {
      clientTurns: { pendingSize: number };
      turnsInFlight: { list(): unknown[] };
      clientMessages: { correlateStart(thread: ThreadRuntime, message: unknown): void };
      turnObservers: { cancelled: (...args: unknown[]) => Promise<void> };
    };
    const cancelled = vi.spyOn(internals.turnObservers, "cancelled");
    await expect(host.prompt("same follow-up", [], "session", { clientTurnId: "old-turn", clientMessageId: "old-message" })).rejects.toThrow("compaction is in progress");
    expect(internals.clientTurns.pendingSize).toBe(0);
    expect(internals.turnsInFlight.list()).toEqual([]);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(runtime.pendingClientMessageIds).toEqual([]);
    refuse = false;
    await host.prompt("same follow-up", [], "session", { clientTurnId: "next-turn", clientMessageId: "next-message" });
    const message = { role: "user", content: [{ type: "text", text: "same follow-up" }], timestamp: 1 };
    internals.clientMessages.correlateStart(runtime, message);
    expect(message).toMatchObject({ clientTurnId: "next-turn", clientMessageId: "next-message" });
    expect(internals.clientTurns.pendingSize).toBe(0);
    expect(runtime.inFlightClientMessageIds).toEqual(new Set(["next-message"]));
  });
});

describe("PiHost prompt preflight", () => {
  it.each(["started", "queued", "handled"] as const)("resolves after SDK preflight %s and reports later run errors", async (disposition) => {
    let rejectRun!: (error: Error) => void;
    const run = new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: async (_text: string, options?: PromptOptions) => {
        options?.preflightResult?.(disposition);
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
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: async () => { throw new Error("The prompt was rejected before it started."); },
    };
    const emit = vi.fn();
    const host = new PiHost("/repo", emit, {} as never, true, false);
    await adoptPiPromptThread(host, session);
    const preflight = vi.fn();

    await expect(host.prompt("hello", [], "session", preflight)).rejects.toThrow("prompt was rejected before it started");
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ accepted: false, error: expect.any(Error) }));
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
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
    const thread = piPromptThread(session, [
      { type: "message", id: "user", message: { role: "user", content: "inspect" } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolCallId: "call", content: output, isError: false } },
    ]);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: thread });

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
    const thread = piPromptThread(session, [
      { type: "message", id: "user", message: { role: "user", content: "inspect" } },
      { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
      { type: "message", id: "result", message: { role: "toolResult", toolCallId: "call", content: output, isError: false } },
    ]);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: thread });

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
    attachRuntimeWithBridge(host, {
      snapshot: { sessionId: "session" } as PiBridgeSnapshot,
      command: bridgeCommand as (...args: unknown[]) => unknown,
    });

    await expect(host.readToolOutput("session", "call")).resolves.toMatchObject({
      toolCallId: "call",
      output,
      totalBytes: Buffer.byteLength(output, "utf8"),
      truncated: false,
    });
    expect(bridgeCommand.mock.calls.length).toBeGreaterThan(1_000);
  });
});

describe("PiHost deferred tool output", () => {
  const session = { sessionId: "session", model: { input: ["text"] }, isStreaming: false, prompt: vi.fn() };
  const entries = (output: string) => [
    { type: "message", id: "user", message: { role: "user", content: "inspect" } },
    { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } },
    { type: "message", id: "result", message: { role: "toolResult", toolCallId: "call", content: output, isError: false } },
  ];

  it("pages a large output as its size and reads back the preview the page held back", async () => {
    const output = `${"line of output\n".repeat(20_000)}last`;
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const raw = entries(output);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: piPromptThread(session, raw) });
    const preview = turnActivityHistoryFromMessages(raw.map((entry) => entry.message)).at(-1)!.tools[0]!;

    const page = await host.loadTranscript("session");
    const paged = page.turnActivityHistory?.at(-1)?.tools[0];
    expect(paged).toMatchObject({ id: "call", outputDeferred: true, outputLength: preview.output!.length, outputTruncated: true });
    expect(paged).not.toHaveProperty("output");
    await expect(host.toolOutput("session", "call")).resolves.toEqual({
      toolCallId: "call", output: preview.output, outputTruncated: true, fullOutputAvailable: true,
    });
  });

  it("keeps a small output in the page", async () => {
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: piPromptThread(session, entries("small")) });
    const page = await host.loadTranscript("session");
    expect(page.turnActivityHistory?.at(-1)?.tools[0]).toMatchObject({ output: "small" });
    expect(page.turnActivityHistory?.at(-1)?.tools[0]).not.toHaveProperty("outputDeferred");
  });

  it("reads a streamed backend's output from the turn activity it keeps", async () => {
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const thread = piPromptThread(session);
    (thread.backend as { kind: string }).kind = "codex";
    const output = "codex ".repeat(5_000);
    thread.adapterActivity.push({ id: "a1", status: "completed", tools: [{ id: "call", name: "shell", args: {}, status: "done", output, startedAt: 0 }] });
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: thread });
    await expect(host.toolOutput("session", "call")).resolves.toEqual({ toolCallId: "call", output });
    await expect(host.toolOutput("session", "missing")).resolves.toBeUndefined();
  });
});

// The kit is loaded the way the app loads it, straight from `kits/`: this is
// core's side of the seam, so the extension has to be the real one.
const appPath = fileURLToPath(new URL("../..", import.meta.url));
const threadTitlesKit = async () => (await loadBundledKitHostHalves({ appPath })).extensions
  .filter((extension) => extension.id === "tau.thread-titles");

async function titleHost(emit: (event: unknown) => void = () => undefined, createModelRuntime?: () => Promise<never>) {
  const host = new PiHost("/repo", emit as never, {} as never, false, false, {
    hostExtensions: threadTitlesKit,
    ...(createModelRuntime ? { createModelRuntime } : {}),
  });
  await activateHostExtensions(host);
  return host;
}

describe("PiHost.generateThreadTitle", () => {
  it("silently skips automatic title generation until the first message exists", async () => {
    const host = await titleHost();
    const thread = makeActivationThread("session");
    Object.assign(thread.backend, {
      state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
      transcript: async () => [],
    });
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: thread });
    setActiveThread(host, "session");
    setSessionIndex(host, [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 0 }]);

    await expect(host.invokeHostExtension("tau.thread-titles", "generate", { provider: "provider", modelId: "model", force: false, sessionId: "session" }))
      .resolves.toBeUndefined();
  });

  it("titles a new thread from its first prompt while the first run is still streaming", async () => {
    const streaming = true;
    const callOrder: string[] = [];
    const requests: Array<{ system: string; prompt: string }> = [];
    const session = {
      sessionId: "session",
      get isStreaming() { return streaming; },
      sessionName: undefined as string | undefined,
      // The prompt has not been persisted yet: Pi appends it when the loop starts.
      messages: [] as unknown[],
      waitForIdle: async () => {
        callOrder.push("wait");
        await new Promise<void>(() => undefined);
      },
      modelRuntime: {
        getModel: () => ({ provider: "provider", id: "model" }),
        getModels: () => [{ provider: "provider", id: "model" }],
        completeSimple: async (_model: unknown, context: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) => {
          callOrder.push("complete");
          requests.push({ system: context.systemPrompt, prompt: context.messages[0]?.content[0]?.text ?? "" });
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
      cwd: "/repo",
      turnReporting: "streamed" as const,
      capabilities: {
        journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
        completions: {
          complete: async () => { throw new Error("A title never completes through the thread's own runtime."); },
          modelApi: () => undefined,
        },
      },
      state: () => ({
        streaming: session.isStreaming,
        idle: !session.isStreaming,
        hasMessages: true,
        title: session.sessionName,
        sessionFile: "/session.jsonl",
        activeTools: [],
        supportsImageInput: false,
        extensionCount: 0,
      }),
      catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
      models: async () => [],
      composerCommands: () => [],
      waitForIdle: session.waitForIdle,
      transcript: async () => [],
      setTitle: async (title: string) => { session.setSessionName(title); },
      persist: async () => undefined,
      preparePrompt: async () => undefined,
      prompt: async () => ({}),
      abort: async () => undefined,
      dispose: async () => undefined,
      start: async () => undefined,
    };
    const thread = new ThreadRuntime(backend as never, { session } as never);
    const published: unknown[] = [];
    // Titles complete on the host's model runtime, whatever runtime owns the thread.
    const host = await titleHost((event) => published.push(event), async () => session.modelRuntime as never);
    await adoptThread(host, { threadId: "session", cwd: "/repo", runtime: thread });
    setActiveThread(host, "session");
    setSessionIndex(host, [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 }]);

    const generated = host.invokeHostExtension("tau.thread-titles", "generate", {
      provider: "provider", modelId: "model", force: false, sessionId: "session", prompt: "Fix automatic titles",
    });
    await expect(generated).resolves.toEqual({ title: "Automatic Thread Titles" });
    expect(callOrder).toEqual(["complete"]);
    // The prompt is the kit's wording; core neither writes nor inspects it.
    expect(requests).toHaveLength(1);
    expect(requests[0].system).toMatch(/plain-text noun phrase/u);
    expect(requests[0].prompt).toContain("user: Fix automatic titles");
    expect(published).toContainEqual(expect.objectContaining({
      type: "host-update",
      update: expect.objectContaining({ type: "thread-shell", update: { sessionId: "session", shell: expect.objectContaining({ title: "Automatic Thread Titles" }) } }),
    }));

    await expect(host.invokeHostExtension("tau.thread-titles", "generate", { provider: "provider", modelId: "model", force: true, sessionId: "session" }))
      .rejects.toThrow("Wait for the active agent run before generating a title.");
  });

  it("does not let a stale new-thread activation replace a newer live switch", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const makeThread = (threadId: string) => makeActivationThread(threadId);
    const staleThread = makeThread("new-thread");
    const liveThread = makeThread("live-thread");
    await adoptThread(host, { threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread });
    await adoptThread(host, { threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    
    const internals = rawInternals(host);
    const lifecycle = internals.lifecycle as { beginActivation(): number };
    const activateThread = internals.activateThread!.bind(host);
    internals.rememberProject = async () => {
      if (internals.threads.active?.runtime === staleThread) {
        staleEntered();
        await staleGate;
      }
    };

    const staleEpoch = lifecycle.beginActivation();
    const staleActivation = activateThread(staleThread, true, staleEpoch);
    await staleStarted;
    const liveEpoch = lifecycle.beginActivation();
    await expect(activateThread(liveThread, false, liveEpoch)).resolves.toBe(true);
    releaseStale();

    await expect(staleActivation).resolves.toBe(false);
    expect(getActiveThreadId(host)).toBe("live-thread");
  });

  it("rejects a different runtime reusing an owned thread id before activation hooks run", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const current = makeActivationThread("reused-id");
    const candidate = makeActivationThread("reused-id");
    await adoptThread(host, { threadId: current.threadId, cwd: current.cwd, runtime: current });

    const internals = rawInternals(host);
    const activation = (internals.lifecycle as { beginActivation(): number }).beginActivation();
    await expect(internals.activateThread?.(candidate, true, activation)).rejects.toThrow("different runtime already owns this thread");
    expect(getActiveThreadId(host)).toBeUndefined();
  });

  it("does not let a duplicate prepared handle invalidate another activation", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const runtime = makeActivationThread("prepared-thread");
    internals.runtimes.open = async () => runtime;
    internals.activateThread = vi.fn(async () => true);
    internals.publication.snapshot = async () => ({}) as never;
    internals.publication.lifecycleUpdates = () => [];

    const prepared = await internals.prepareThread({} as never, {} as never);
    await prepared.activate();

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const competing = internals.lifecycle.runActivation("competing", async (activation: { isCurrent(): boolean }) => {
      started();
      await gate;
      return activation.isCurrent();
    });
    await startedPromise;

    await expect(prepared.activate()).rejects.toThrow("This prepared thread was already used.");
    expect(internals.lifecycle.currentActivationEpoch).toBe(2);
    release();
    await expect(competing).resolves.toBe(true);
  });

  it("keeps a superseded newSession alive in the background when a newer live switch wins", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const staleThread = makeActivationThread("new-thread", "/new.jsonl");
    const liveThread = makeActivationThread("live-thread", "/live.jsonl");
    await adoptThread(host, { threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread });
    await adoptThread(host, { threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    
    const released: string[] = [];
    const prompts: string[] = [];
    const internals = rawInternals(host);
    mockInternalMethods(host, {
      rememberProject: async () => {
        if (internals.threads.active?.runtime === staleThread) {
          staleEntered();
          await staleGate;
        }
      },
      refreshShell: async () => {},
      detachBridge: () => {},
      takeSpareThread: async () => undefined,
      openRuntime: async () => staleThread,
      logReplacement: () => {},
      activeUpdates: async () => ({ version: 1, updates: [] }),
      release: async (threadId: string) => { released.push(threadId); },
      prompt: async (text: string) => { prompts.push(text); },
    });
    internals.prewarm.scheduleSpare = () => {};

    const staleNewSession = host.newSession("stale prompt", [], "/repo");
    await staleStarted;
    await expect(host.switchSession("/live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseStale();

    // The live switch owns the visible thread; the new thread still exists and
    // still receives its prompt, so the renderer can show it in the background.
    await expect(staleNewSession).resolves.toEqual({
      version: 1,
      updates: [],
      submission: { accepted: true },
      sessionId: "new-thread",
    });
    await vi.waitFor(() => expect(prompts).toEqual(["stale prompt"]));
    expect(released).toEqual([]);
    expect(getActiveThreadId(host)).toBe("live-thread");
  });

  it("applies an explicit new-thread model to the created runtime", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const thread = makeActivationThread("configured-thread", "/configured.jsonl");
    const selectedModels: Array<{ provider: string; id: string }> = [];
    const selectedLevels: string[] = [];
    thread.backend.capabilities.catalogWrite = {
      setModel: async (provider: string, id: string) => { selectedModels.push({ provider, id }); },
      setThinkingLevel: async (level: string) => { selectedLevels.push(level); },
    };
    mockInternalMethods(host, {
      rememberProject: async () => {},
      refreshShell: async () => {},
      detachBridge: () => {},
      openRuntime: async () => thread,
      logReplacement: () => {},
      activeUpdates: async () => ({ version: 1, updates: [] }),
      prompt: async () => undefined,
    });
    rawInternals(host).prewarm.scheduleSpare = () => {};

    await expect(host.newSession(
      "start with Astra",
      [],
      "/repo",
      undefined,
      undefined,
      { model: { provider: "openai-codex", id: "gpt-6-astra" }, thinkingLevel: "low" },
    )).resolves.toMatchObject({ submission: { accepted: true }, sessionId: "configured-thread" });

    expect(selectedModels).toEqual([{ provider: "openai-codex", id: "gpt-6-astra" }]);
    expect(selectedLevels).toEqual(["low"]);
  });

  it("admits newSession before the lifecycle queue so a later live switch stays visible", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const staleThread = makeActivationThread("queued-new-thread", "/queued-new.jsonl");
    const liveThread = makeActivationThread("warm-live-thread", "/warm-live.jsonl");
    await adoptThread(host, { threadId: staleThread.threadId, cwd: staleThread.cwd, runtime: staleThread });
    await adoptThread(host, { threadId: liveThread.threadId, cwd: liveThread.cwd, runtime: liveThread });

    let releaseLifecycle!: () => void;
    // Occupy the queue the way a slow lifecycle operation would.
    const internals = rawInternals(host);
    void (internals.lifecycle as any).run("test-block", () => new Promise<void>((resolve) => { releaseLifecycle = resolve; }));
    const prompts: string[] = [];
    mockInternalMethods(host, {
      rememberProject: async () => {},
      refreshShell: async () => {},
      detachBridge: () => {},
      takeSpareThread: async () => undefined,
      openRuntime: async () => staleThread,
      logReplacement: () => {},
      activeUpdates: async () => ({ version: 1, updates: [] }),
      release: async () => {},
      prompt: async (text: string) => { prompts.push(text); },
    });
    internals.prewarm.scheduleSpare = () => {};

    const queuedNewSession = host.newSession("sent in the background", [], "/repo");
    await expect(host.switchSession("/warm-live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseLifecycle();

    await expect(queuedNewSession).resolves.toEqual({
      version: 1,
      updates: [],
      submission: { accepted: true },
      sessionId: "queued-new-thread",
    });
    await vi.waitFor(() => expect(prompts).toEqual(["sent in the background"]));
    expect(getActiveThreadId(host)).toBe("warm-live-thread");
  });

  it("accepts a new-thread submission after activation without holding the composer for prompt preflight", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const thread = makeActivationThread("new-thread", "/new.jsonl");
    internals.rememberProject = async () => {};
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    let releaseCatalog!: () => void;
    const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    internals.publication.ensureModels = async () => {
      // A real AgentSession can serialize catalog access with prompt delivery.
      // This is the regression seam: acceptance must not await this read at
      // all. The read is allowed to finish later and publish its update.
      await catalog;
      return [];
    };
    internals.publication.activeUpdates = async () => {
      await internals.publication.ensureModels();
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.snapshotSync = () => ({
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
    internals.publication.activeUpdates = async () => {
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => newThread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
    let acceptPrompt!: () => void;
    const preflight = new Promise<void>((resolve) => { acceptPrompt = resolve; });
    internals.prompt = vi.fn(async () => preflight);

    const creation = host.newSession("start the work", [], "/repo");
    await vi.waitFor(() => expect(internals.prompt).toHaveBeenCalled());

    internals.index.sessions = [{
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
    internals.runtimes.openForPath = async () => coldThread;
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
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
    internals.index.refreshShell = async () => {};
    internals.detachBridge = () => {};
    internals.takePreparedThread = async () => undefined;
    internals.runtimes.open = async () => thread;
    internals.logReplacement = () => {};
    internals.prewarm.scheduleSpare = () => {};
    internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
    // The real prompt() runs here so the marker bookkeeping is exercised.
    thread.backend.prompt = async (input: { onAdmitted?: (accepted: boolean) => void }) => {
      input.onAdmitted?.(true);
      return {};
    };
    thread.backend.preparePrompt = async (text: string) => ({ runtimeText: text, visibleText: text });
    internals.prompts.assertBound = () => {};

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
    expect(internals.index.snapshot().projects).toEqual([]);
    await internals.projects.settleClassifications();

    expect(internals.index.snapshot().projects.map((project: { path: string }) => project.path))
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
      attached: { session: { snapshot?: PiBridgeSnapshot } };
      projection: { attachedHostSnapshot(): HostSnapshot };
      publication: { detailForSnapshot(snapshot: HostSnapshot): ThreadDetail };
    };
    internals.attached.session.snapshot = bridgeSnapshot;

    const projected = internals.projection.attachedHostSnapshot();
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
    const detail = internals.publication.detailForSnapshot(projected);
    expect(detail.messages).toHaveLength(20);
    expect(detail.olderCursor).toBe(projected.olderCursor);
    expect(detail.transcriptWindow).toBe("bounded");

    let persisted: string | null = null;
    const storage = {
      get: () => persisted,
      set: (_key: string, value: string) => { persisted = value; },
      remove: () => { persisted = null; },
      keys: () => (persisted === null ? [] : ["cache"]),
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
