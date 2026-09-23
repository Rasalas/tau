import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { LIMIT_CONTINUATION_PROMPT } from "./thread-limits.js";
import { ThreadRuntime } from "./thread-runtime.js";

interface DeliveredPrompt { text: string; hidden?: boolean }

/** A streamed non-Pi thread whose turn runs until the test ends it with a `turn-settled`. */
function streamedThread(threadId: string, delivered: DeliveredPrompt[]) {
  let streaming = false;
  const backend = {
    kind: "external-test" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: { resume: { hiddenPrompt: true } },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: "external-test" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities, visibleText: text, runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; hidden?: boolean; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push({ text: input.text, ...(input.hidden ? { hidden: true } : {}) });
      streaming = true;
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({ streaming, idle: !streaming, hasMessages: true, activeTools: [], supportsImageInput: true, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    transcript: async () => [],
    persist: async () => undefined,
    setTitle: async () => undefined,
    abort: async () => { streaming = false; },
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return { runtime: new ThreadRuntime(backend as never), stop: () => { streaming = false; } };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function host(dir?: string) {
  const userData = dir ?? await mkdtemp(join(tmpdir(), "tau-host-queue-"));
  if (!dir) dirs.push(userData);
  const delivered: DeliveredPrompt[] = [];
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const piHost = new PiHost("/repo", () => undefined, history as never, false, false, {
    queuedMessagesPath: join(userData, "queued-messages.json"),
    threadLimitsPath: join(userData, "thread-limits.json"),
  });
  const internals = piHost as unknown as Record<string, any>;
  internals.index.refreshShell = async () => {};
  const thread = streamedThread("thread-1", delivered);
  internals.threads.adopt({ threadId: "thread-1", cwd: "/repo", runtime: thread.runtime, isolation: "in-process" });
  internals.threads.setActive("thread-1");
  /** The runtime reports the end of its turn the way a streamed backend does. */
  const settle = (error?: string, limit?: { resetsAt?: number }) => {
    thread.stop();
    internals.handleBackendEvent("thread-1", { type: "turn-settled", status: error ? "error" : "completed", ...(error ? { error } : {}), ...(limit ? { limit } : {}) });
  };
  return { host: piHost, internals, delivered, settle, userData };
}

describe("PiHost queue and limits", () => {
  it("sends a queued message when the running turn ends", async () => {
    const bench = await host();
    await bench.host.prompt("long job", [], "thread-1");
    bench.host.queue.add("thread-1", { text: "then this", attachments: [] });
    expect(bench.delivered.map((entry) => entry.text)).toEqual(["long job"]);
    bench.settle();
    await vi.waitFor(() => expect(bench.delivered.map((entry) => entry.text)).toEqual(["long job", "then this"]));
    await bench.host.queue.flush();
  });

  it("keeps a queued message across a host restart and holds it for the user", async () => {
    const first = await host();
    await first.host.prompt("long job", [], "thread-1");
    first.host.queue.add("thread-1", { text: "after the restart", attachments: [] });
    await first.host.queue.flush();

    const second = await host(first.userData);
    const setQueue = vi.spyOn(second.internals.index, "setQueue");
    await second.internals.reconcileInterruptedTurns();
    expect(setQueue).toHaveBeenCalledWith("thread-1", { held: true, messages: [{ id: expect.any(String), text: "after the restart", attachments: 0 }] });
    second.settle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.delivered).toEqual([]);
  });

  it("marks a limit stop, holds the queue, and continues when asked", async () => {
    const bench = await host();
    const setLimit = vi.spyOn(bench.internals.index, "setLimit");
    await bench.host.prompt("long job", [], "thread-1");
    bench.host.queue.add("thread-1", { text: "next", attachments: [] });
    bench.settle("Your workspace is out of credits.", { resetsAt: Date.now() + 60 * 60_000 });
    expect(setLimit).toHaveBeenLastCalledWith("thread-1", expect.objectContaining({ message: "Your workspace is out of credits." }));
    expect(bench.host.queue.isHeld("thread-1")).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(bench.delivered.map((entry) => entry.text)).toEqual(["long job"]);

    await bench.host.limits.resumeNow("thread-1");
    expect(bench.delivered.at(-1)).toEqual({ text: LIMIT_CONTINUATION_PROMPT, hidden: true });
    expect(setLimit).toHaveBeenLastCalledWith("thread-1", undefined);
    // The continuation lifted the hold; the queue follows it.
    bench.settle();
    await vi.waitFor(() => expect(bench.delivered.at(-1)?.text).toBe("next"));
    await bench.host.queue.flush();
  });
});
