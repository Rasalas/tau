import { describe, expect, it, vi } from "vitest";
import { ThreadBinding, type ThreadBindingPort } from "./thread-binding.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

function bindableThread(bind: () => Promise<void>, options: { extensions?: boolean } = {}) {
  const events: Array<(event: unknown, threadId: string) => void> = [];
  let lifecycleReset: (() => void) | undefined;
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId: "session",
    providerSessionId: "session",
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
      events: { subscribe: (listener: (event: unknown, threadId: string) => void) => { events.push(listener); } },
      ...(options.extensions === false ? {} : {
        extensions: {
          bind,
          unbind: () => undefined,
          setLifecycleHooks: (reset: () => void) => { lifecycleReset = reset; },
        },
      }),
    },
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
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
  return { thread: new ThreadRuntime(backend as never), events, reset: () => lifecycleReset?.() };
}

function makeBinding(overrides: Partial<ThreadBindingPort> = {}) {
  const failures: unknown[] = [];
  const logs: string[] = [];
  const catalogs = vi.fn(async () => undefined);
  const port: ThreadBindingPort = {
    extensionUi: { ask: async () => undefined } as never,
    clientTurns: { settle: vi.fn() } as never,
    clientMessages: { forget: vi.fn() } as never,
    turnObservers: { reset: vi.fn(async () => undefined) } as never,
    projection: { composerCommands: () => [] } as never,
    isActive: () => true,
    isCurrent: () => true,
    onSessionEvent: () => undefined,
    emitForThread: () => undefined,
    presentUi: () => true,
    setWindowTitle: () => undefined,
    publishActiveCatalog: catalogs,
    recordBackground: () => undefined,
    logPhase: () => undefined,
    log: (label) => { logs.push(label); },
    logForThread: (_thread, label) => { logs.push(label); },
    fail: (error) => { failures.push(error); },
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    ...overrides,
  };
  return { binding: new ThreadBinding(port), port, failures, logs, catalogs };
}

describe("ThreadBinding", () => {
  it("publishes the catalog after a binding of the thread on screen", async () => {
    const { binding, catalogs } = makeBinding();
    const { thread } = bindableThread(async () => undefined);
    await binding.bind(thread);
    expect(catalogs).toHaveBeenCalledOnce();
  });

  it("does nothing for a runtime without extensions", async () => {
    const { binding, catalogs } = makeBinding();
    const { thread, events } = bindableThread(async () => undefined, { extensions: false });
    await binding.bind(thread);
    expect(catalogs).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("leaves the error with the caller of an awaited binding", async () => {
    const { binding, failures } = makeBinding();
    const { thread } = bindableThread(async () => { throw new Error("bind refused"); });
    await expect(binding.bind(thread)).rejects.toThrow("bind refused");
    expect(failures).toEqual([]);
  });

  it("reports its own failure when the binding was deferred", async () => {
    const { binding, failures } = makeBinding();
    const { thread } = bindableThread(async () => { throw new Error("bind refused"); });
    await expect(binding.bind(thread, true)).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it("logs instead of failing when the thread was replaced while it bound", async () => {
    const { binding, failures, logs } = makeBinding({ isCurrent: () => false });
    const { thread } = bindableThread(async () => { throw new Error("bind refused"); });
    await binding.bind(thread, true);
    expect(failures).toEqual([]);
    expect(logs).toContain("runtime.bind.failed");
  });

  it("settles a deferred binding and forgets it afterwards", async () => {
    const { binding } = makeBinding();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { thread } = bindableThread(() => gate);
    const deferred = binding.bind(thread, true);
    let settled = false;
    const waiting = binding.settle(thread).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await deferred;
    await waiting;
    expect(settled).toBe(true);
    // A thread with nothing pending resolves at once.
    await expect(binding.settle(thread)).resolves.toBeUndefined();
  });

  it("subscribes the host to the runtime's events", async () => {
    const seen: string[] = [];
    const { binding } = makeBinding({ onSessionEvent: (_event, _thread, threadId) => { seen.push(threadId); } });
    const { thread, events } = bindableThread(async () => undefined);
    await binding.bind(thread);
    events[0]?.({ type: "agent_settled" }, "session");
    expect(seen).toEqual(["session"]);
  });

  it("resets the thread's live state when the runtime reloads", async () => {
    const { binding, port } = makeBinding();
    const { thread, reset } = bindableThread(async () => undefined);
    binding.installHooks(thread);
    reset();
    expect(port.clientTurns.settle).toHaveBeenCalledWith("session");
    expect(port.turnObservers.reset).toHaveBeenCalledWith("session");
  });
});
