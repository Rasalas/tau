import { describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { RESTART_CONTINUATION_PROMPT } from "./turn-reconciliation.js";
import type { InFlightTurn } from "./turns-in-flight.js";

interface DeliveredPrompt { text: string; hidden?: boolean }

/** A streamed non-Pi thread whose turn stays in flight until it is released. */
function heldThread(threadId: string, delivered: DeliveredPrompt[]) {
  let streaming = false;
  let release!: () => void;
  const reload = vi.fn(async () => undefined);
  const abort = vi.fn(async () => { streaming = false; });
  const dispose = vi.fn(async () => undefined);
  const notice = vi.fn(async () => undefined);
  const backend = {
    kind: "external-test" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: { reload: { reload }, resume: { hiddenPrompt: true, notice } },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId,
      providerSessionId: threadId,
      sessionId: threadId,
      backendKind: "external-test" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: text,
      runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; hidden?: boolean; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push({ text: input.text, ...(input.hidden ? { hidden: true } : {}) });
      streaming = true;
      input.onAdmitted?.(true);
      await new Promise<void>((resolve) => { release = () => { streaming = false; resolve(); }; });
      return {};
    },
    state: () => ({ streaming, idle: !streaming, hasMessages: true, activeTools: [], supportsImageInput: true, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    abort,
    dispose,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return { runtime: new ThreadRuntime(backend as never), release: () => release(), reload, abort, dispose, notice };
}

function host() {
  const delivered: DeliveredPrompt[] = [];
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const piHost = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = piHost as unknown as Record<string, any>;
  internals.rememberProject = async () => {};
  internals.index.refreshShell = async () => {};
  internals.index.refresh = async () => {};
  internals.prewarm.scheduleThreads = () => {};
  internals.prewarm.scheduleSpare = () => {};
  internals.projects.label = () => undefined;

  const thread = heldThread("thread-1", delivered);
  internals.threads.adopt({ threadId: "thread-1", cwd: "/repo", runtime: thread.runtime, isolation: "in-process" });
  internals.threads.setActive("thread-1");
  return {
    host: piHost,
    internals,
    thread,
    delivered,
    markers: (): readonly InFlightTurn[] => internals.turnsInFlight.list(),
  };
}

describe("PiHost turn markers", () => {
  it("records a marker while the turn is in flight and clears it when the turn ends", async () => {
    const bench = host();
    await bench.host.prompt("count to three", [], "thread-1");

    expect(bench.markers()).toEqual([expect.objectContaining({
      sessionId: "thread-1",
      cwd: "/repo",
      backend: "external-test",
      prompt: { text: "count to three" },
    })]);

    bench.thread.release();
    await vi.waitFor(() => expect(bench.markers()).toEqual([]));
  });

  it("counts attached images without copying them into the marker", async () => {
    const bench = host();
    await bench.host.prompt("look", [{ kind: "image", mimeType: "image/png", data: "AAAA", size: 3, name: "shot.png" }], "thread-1");
    expect(bench.markers()[0]?.prompt).toEqual({ text: "look", images: 1 });
    bench.thread.release();
  });

  it("clears the thread's interrupted and failed marks as soon as it is prompted again", async () => {
    const bench = host();
    const setInterrupted = vi.spyOn(bench.internals.index, "setInterrupted");
    const setTurnError = vi.spyOn(bench.internals.index, "setTurnError");
    await bench.host.prompt("go on", [], "thread-1");
    expect(setInterrupted).toHaveBeenCalledWith("thread-1", false);
    expect(setTurnError).toHaveBeenCalledWith("thread-1", undefined);
    bench.thread.release();
  });

  it("delivers a continuation the transcript does not attribute to the user", async () => {
    const bench = host();
    await bench.host.prompt(RESTART_CONTINUATION_PROMPT, [], "thread-1", undefined, undefined, { hidden: true });
    expect(bench.delivered).toEqual([{ text: RESTART_CONTINUATION_PROMPT, hidden: true }]);
    bench.thread.release();
  });
});

describe("PiHost reloadExtensions", () => {
  it("leaves a runtime with a turn in flight alone, where a runtime reload refuses", async () => {
    const bench = host();
    void bench.host.prompt("long job", [], "thread-1");
    await vi.waitFor(() => expect(bench.markers()).toHaveLength(1));

    await bench.host.reloadExtensions();

    expect(bench.thread.reload).not.toHaveBeenCalled();
    expect(bench.thread.abort).not.toHaveBeenCalled();
    expect(bench.thread.dispose).not.toHaveBeenCalled();
    // The thread is still the one the host holds, still running.
    expect(bench.internals.threads.get("thread-1").runtime).toBe(bench.thread.runtime);
    expect(bench.markers()).toHaveLength(1);

    // The runtime route does reach the runtime, which is the whole difference.
    await bench.host.reloadRuntime();
    expect(bench.thread.reload).toHaveBeenCalledOnce();
    bench.thread.release();
  });
});


describe("targeted session restart", () => {
  function restartable() {
    const bench = host();
    const restart = vi.fn<() => Promise<void>>(async () => undefined);
    bench.thread.runtime.backend.capabilities.restart = { restart };
    vi.spyOn(bench.internals.publication, "activeUpdates").mockResolvedValue({ version: 1, updates: [] });
    return { ...bench, restart };
  }

  it("preserves the active external thread and does not dispose another thread", async () => {
    const bench = restartable();
    const state = bench.thread.runtime.backend.state.bind(bench.thread.runtime.backend);
    bench.thread.runtime.backend.state = () => ({ ...state(), activeTools: ["read", "bash", "write"] });
    const other = heldThread("other-thread", []);
    await bench.internals.threads.adopt({ threadId: "other-thread", cwd: "/repo", runtime: other.runtime, isolation: "in-process" });
    await bench.host.restartSession("thread-1");
    expect(bench.restart).toHaveBeenCalledOnce();
    expect(bench.internals.threads.get("thread-1").runtime).toBe(bench.thread.runtime);
    expect(other.dispose).not.toHaveBeenCalled();
  });

  it("refuses a stale command instead of restarting the newly selected thread", async () => {
    const bench = restartable();
    const other = heldThread("other-thread", []);
    await bench.internals.threads.adopt({ threadId: "other-thread", cwd: "/repo", runtime: other.runtime, isolation: "in-process" });
    bench.internals.threads.setActive("other-thread");
    await expect(bench.host.restartSession("thread-1")).rejects.toThrow("Open this thread");
    expect(bench.restart).not.toHaveBeenCalled();
  });

  it("refuses pending messages before stopping the runtime", async () => {
    const bench = restartable();
    bench.thread.runtime.pendingClientMessageIds.push("queued-message");
    await expect(bench.host.restartSession("thread-1")).rejects.toThrow("running work");
    expect(bench.restart).not.toHaveBeenCalled();
  });

  it("holds prompt admission until a delayed restart completes", async () => {
    const bench = restartable();
    let release!: () => void;
    bench.restart.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const restarting = bench.host.restartSession("thread-1");
    await vi.waitFor(() => expect(bench.restart).toHaveBeenCalledOnce());
    await expect(bench.host.prompt("New work", [], "thread-1")).rejects.toThrow("session is restarting");
    expect(bench.delivered).toEqual([]);
    release();
    await restarting;
  });

  it("rejects an old prepared prompt even when an external restart has already completed", async () => {
    const bench = restartable();
    bench.thread.runtime.backend.capabilities.journal = { entries: () => [], appendCustomEntry: () => {}, appendMessage: () => {} } as never;
    const original = bench.thread.runtime.backend.preparePrompt;
    let release!: () => void;
    bench.thread.runtime.backend.preparePrompt = async (text) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return original(text);
    };
    const send = bench.host.prompt("Prepared before restart", [], "thread-1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await bench.host.restartSession("thread-1");
    release();
    await expect(send).rejects.toThrow("session changed");
    expect(bench.delivered).toEqual([]);
  });

  it("refuses to restart during a project shell action even when the agent is idle", async () => {
    const bench = restartable();
    let running = false;
    let release!: () => void;
    const result = { output: "done", exitCode: 0, cancelled: false, truncated: false };
    bench.thread.runtime.backend.capabilities.shellAction = {
      isRunning: () => running,
      run: async () => {
        running = true;
        try { await new Promise<void>((resolve) => { release = resolve; }); return result; }
        finally { running = false; }
      },
    };
    vi.spyOn(bench.internals.publication, "publishDetail").mockResolvedValue({} as never);
    const action = bench.host.runShellAction("long project command");
    await vi.waitFor(() => expect(running).toBe(true));
    expect(bench.thread.runtime.state.idle).toBe(true);
    await expect(bench.host.restartSession("thread-1")).rejects.toThrow("running work");
    expect(bench.restart).not.toHaveBeenCalled();
    release();
    expect(await action).toEqual(result);
  });

  it.each(["during", "after"])("refuses an action prepared %s an external restart", async (when) => {
    const bench = restartable();
    const run = vi.fn(async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }));
    bench.thread.runtime.backend.capabilities.shellAction = { isRunning: () => false, run };
    let bind!: () => void;
    vi.spyOn(bench.internals.binding, "settle").mockImplementation(() => new Promise<void>((resolve) => { bind = resolve; }));
    const action = bench.host.runShellAction("old project command");
    await vi.waitFor(() => expect(bind).toBeTypeOf("function"));
    let finish!: () => void;
    bench.restart.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const restart = bench.host.restartSession("thread-1");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (when === "after") { finish(); await restart; }
    bind();
    await expect(action).rejects.toThrow(when === "during" ? "session is restarting" : "session changed");
    expect(run).not.toHaveBeenCalled();
    if (when === "during") { finish(); await restart; }
  });

  it("refuses a shell action if its bound runtime was replaced", async () => {
    const bench = restartable();
    const run = vi.fn(async () => ({ output: "", exitCode: 0, cancelled: false, truncated: false }));
    bench.thread.runtime.backend.capabilities.shellAction = { isRunning: () => false, run };
    let bind!: () => void;
    vi.spyOn(bench.internals.binding, "settle").mockImplementation(() => new Promise<void>((resolve) => { bind = resolve; }));
    const action = bench.host.runShellAction("old project command");
    await vi.waitFor(() => expect(bind).toBeTypeOf("function"));
    const replacement = heldThread("thread-1", []);
    await bench.internals.threads.adopt({ threadId: "thread-1", cwd: "/repo", runtime: replacement.runtime, isolation: "in-process" });
    bind();
    await expect(action).rejects.toThrow("session changed");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a recoverable transcript shell if the Pi runtime fails to reopen", async () => {
    const bench = restartable();
    Object.defineProperty(bench.thread.runtime, "runtime", { value: { session: { abort: async () => undefined }, dispose: async () => undefined } });
    vi.spyOn(bench.internals.runtimes, "openForPath").mockRejectedValue(new Error("Broken extension"));
    bench.internals.activateThread = async (thread: ThreadRuntime) => { bench.internals.threads.setActive(thread.threadId); return true; };
    await expect(bench.host.restartSession("thread-1")).rejects.toThrow("Open this thread again to retry");
    const kept = bench.internals.threads.get("thread-1").runtime;
    expect(kept.threadId).toBe("thread-1");
    expect(kept.backend.kind).toBe("external-test");
    expect(kept.backend.reason).toContain("Broken extension");
    expect(bench.internals.threads.active.runtime).toBe(kept);
  });
});
