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

  it("clears the thread's interrupted mark as soon as it is prompted again", async () => {
    const bench = host();
    const setInterrupted = vi.spyOn(bench.internals.index, "setInterrupted");
    await bench.host.prompt("go on", [], "thread-1");
    expect(setInterrupted).toHaveBeenCalledWith("thread-1", false);
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
