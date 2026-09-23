import { describe, expect, it, vi } from "vitest";
import { ThreadRuntimeLifecycle, type ThreadRuntimeLifecyclePort } from "./thread-runtime-lifecycle.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

function externalBackend(threadId: string, options: { streaming?: boolean } = {}) {
  return {
    kind: "test" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "awaited" as const,
    capabilities: {},
    state: () => ({ streaming: options.streaming ?? false, idle: !options.streaming, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0, title: "Named" }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
}

function makeLifecycle(overrides: Partial<ThreadRuntimeLifecyclePort> = {}, backends: Record<string, unknown> = {}) {
  const adopted: ThreadRuntime[] = [];
  const emitted: Array<{ threadId: string; event?: string }> = [];
  const released: string[] = [];
  const port: ThreadRuntimeLifecyclePort = {
    safeMode: false,
    agentDir: "/agent",
    cwd: () => "/repo",
    activeSessionFile: () => undefined,
    adapterFor: () => PI_AGENT_RUNTIME_ADAPTER,
    requireBackend: (kind) => {
      const provider = backends[kind];
      if (!provider) throw new Error(`Runtime backend "${kind}" is not installed`);
      return provider as never;
    },
    permissionLevel: () => "full",
    sessionFile: () => ({}) as never,
    runtimeExtensions: () => [],
    runtimeExtensionNames: () => [],
    runtimeModes: () => [],
    threadLifecycle: { beforeOpen: vi.fn(async () => undefined) } as never,
    turnObservers: { closed: vi.fn(async () => undefined) } as never,
    clientTurns: { settle: vi.fn() } as never,
    extensionUi: { cancelFor: vi.fn(), ask: vi.fn(async () => ({ confirmed: true })) } as never,
    projection: { mapping: () => ({}) } as never,
    projects: { name: () => "repo", knownLabel: () => undefined } as never,
    binding: { bind: vi.fn(async () => undefined), installHooks: vi.fn() } as never,
    lifecycleMetrics: { isActive: () => false, begin: vi.fn(), end: vi.fn() } as never,
    adopt: async (thread) => { adopted.push(thread); },
    currentRuntime: () => undefined,
    liveThreadForPath: () => undefined,
    indexedSession: () => undefined,
    presentUi: () => true,
    releaseTool: (id) => { released.push(id); },
    emitMessage: (threadId) => { emitted.push({ threadId }); },
    emitRuntimeEvent: (threadId, event) => { emitted.push({ threadId, event: event.type }); },
    logRuntimePhase: () => undefined,
    log: () => undefined,
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    ...overrides,
  };
  return { lifecycle: new ThreadRuntimeLifecycle(port), port, adopted, emitted, released };
}

describe("ThreadRuntimeLifecycle", () => {
  it("refuses a non-Pi backend in safe mode", async () => {
    const { lifecycle } = makeLifecycle({ safeMode: true });
    await expect(lifecycle.openExternal("test", "thread", "/repo")).rejects.toThrow("Tau safe mode");
  });

  it("adopts an opened external thread and carries its title over", async () => {
    const backend = externalBackend("thread");
    const provider = { open: async () => backend };
    const { lifecycle, adopted } = makeLifecycle({}, { test: provider });
    const thread = await lifecycle.openExternal("test", "thread", "/repo");
    expect(thread.adapterTitle).toBe("Named");
    expect(adopted).toEqual([thread]);
  });

  it("leaves an unadopted external thread out of the registry", async () => {
    const provider = { open: async () => externalBackend("thread") };
    const { lifecycle, adopted } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo", { adopt: false });
    expect(adopted).toEqual([]);
  });

  it("delivers a backend's own messages to the transcript of the live thread", async () => {
    let deliver!: (message: { role: string; text: string }) => void;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { onMessage: (message: unknown) => void }) => {
        deliver = context.onMessage as never;
        return externalBackend("thread");
      },
    };
    const live = { adapterMessages: [] as unknown[] };
    const { lifecycle, emitted } = makeLifecycle({ currentRuntime: () => live as never }, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    deliver({ role: "assistant", text: "done" });
    expect(live.adapterMessages).toHaveLength(1);
    expect(emitted).toEqual([{ threadId: "thread" }]);
  });

  it("routes a streamed backend's runtime events to the host under the thread's id", async () => {
    let report!: (event: { type: string }) => void;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { onEvent: (event: unknown) => void }) => {
        report = context.onEvent as never;
        return externalBackend("thread");
      },
    };
    const { lifecycle, emitted } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    report({ type: "turn-started" });
    expect(emitted).toEqual([{ threadId: "thread", event: "turn-started" }]);
  });

  it("puts a backend's question on the workbench dialog surface under the thread's id", async () => {
    let ask!: (prompt: { kind: string; title: string }) => Promise<unknown>;
    const provider = {
      open: async (_id: string, _cwd: string, _options: unknown, context: { ask: (prompt: unknown) => Promise<unknown> }) => {
        ask = context.ask as never;
        return externalBackend("thread");
      },
    };
    const { lifecycle, port } = makeLifecycle({}, { test: provider });
    await lifecycle.openExternal("test", "thread", "/repo");
    await expect(ask({ kind: "confirm", title: "Approve Bash?" })).resolves.toEqual({ confirmed: true });
    expect(port.extensionUi.ask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm", title: "Approve Bash?", sessionId: "thread", id: expect.stringMatching(/^backend-/u) }),
      undefined,
    );
  });

  it("hands a live thread back instead of opening its session file twice", async () => {
    const existing = new ThreadRuntime(externalBackend("thread") as never);
    const { lifecycle } = makeLifecycle({ liveThreadForPath: () => existing });
    await expect(lifecycle.openForPath("/a.jsonl", "resume")).resolves.toBe(existing);
    expect(lifecycle.isOpening("/a.jsonl")).toBe(false);
  });

  it("shares one open between concurrent callers for the same path", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backend = externalBackend("thread");
    const provider = {
      lookup: async () => ({ threadId: "thread", cwd: "/repo" }),
      open: async () => { await gate; return backend; },
    };
    const { lifecycle } = makeLifecycle({ indexedSession: () => ({ id: "thread", backendKind: "test" }) as never }, { test: provider });
    const first = lifecycle.openForPath("/a.jsonl", "resume");
    const second = lifecycle.openForPath("/a.jsonl", "resume");
    expect(lifecycle.isOpening("/a.jsonl")).toBe(true);
    release();
    expect(await first).toBe(await second);
    expect(lifecycle.isOpening("/a.jsonl")).toBe(false);
  });

  it("refuses to open a thread with a different backend than persisted (ADR 0005)", async () => {
    const provider = { lookup: async () => ({ threadId: "thread", cwd: "/repo" }), open: async () => externalBackend("thread") };
    const { lifecycle } = makeLifecycle(
      { indexedSession: () => ({ id: "thread", backendKind: "existing-backend" }) as never },
      { "existing-backend": provider, "requested-backend": provider },
    );
    await expect(lifecycle.openForPath("/a.jsonl", "resume", false, "requested-backend" as never))
      .rejects.toThrow(/belongs to backend existing-backend.*refusing to open it as requested-backend/u);
  });

  it("refuses a path whose backend no longer knows the thread", async () => {
    const provider = { lookup: async () => undefined };
    const { lifecycle } = makeLifecycle({ indexedSession: () => ({ id: "thread", backendKind: "test" }) as never }, { test: provider });
    await expect(lifecycle.openForPath("/a.jsonl", "resume")).rejects.toThrow("no longer available");
  });

  it("aborts a streaming backend before disposing it and releases its tools", async () => {
    const backend = externalBackend("thread", { streaming: true });
    const thread = new ThreadRuntime(backend as never);
    thread.tools.set("call", {} as never);
    const { lifecycle, released, port } = makeLifecycle();
    await lifecycle.dispose(thread);
    expect(backend.abort).toHaveBeenCalled();
    expect(backend.dispose).toHaveBeenCalled();
    expect(released).toEqual(["call"]);
    expect(port.turnObservers.closed).toHaveBeenCalledWith("thread");
  });

  it("collects a failing teardown into one aggregate", async () => {
    const backend = externalBackend("thread");
    backend.dispose = vi.fn(async () => { throw new Error("dispose failed"); });
    const thread = new ThreadRuntime(backend as never);
    const { lifecycle } = makeLifecycle();
    await expect(lifecycle.dispose(thread)).rejects.toThrow(AggregateError);
  });

  it("answers a stable resource fingerprint that safe mode changes", () => {
    const full = makeLifecycle().lifecycle;
    const safe = makeLifecycle({ safeMode: true }).lifecycle;
    expect(full.fingerprint("/repo")).toBe(full.fingerprint("/repo"));
    expect(full.fingerprint("/repo")).not.toBe(safe.fingerprint("/repo"));
    expect(full.fingerprint("/repo")).not.toBe(full.fingerprint("/other"));
  });
});
