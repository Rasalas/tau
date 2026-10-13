import { describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint, CLIENT_MESSAGE_MARKER } from "../shared/client-message-correlation.js";
import { createNewThreadRequestId } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import type { ThreadBackendPromptInput } from "./runtime-types.js";
import { ThreadRuntime } from "./thread-runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeThread(threadId: string, journal: boolean, deliver: (input: ThreadBackendPromptInput) => Promise<void>) {
  const entries: unknown[] = [];
  const prompt = vi.fn(async (input: ThreadBackendPromptInput) => { await deliver(input); return {}; });
  const backend = {
    kind: "pi" as const, runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId, providerSessionId: threadId, cwd: "/repo", turnReporting: "streamed" as const,
    capabilities: journal ? {
      journal: {
        entries: () => entries,
        appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
        appendMessage: () => undefined,
      },
    } : {},
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: "pi" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities, visibleText: text, runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [], prompt,
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [], transcript: async () => [], persist: async () => undefined,
    setTitle: async () => undefined, abort: async () => undefined, dispose: async () => undefined,
    start: async () => undefined, waitForIdle: async () => undefined,
  };
  return { thread: new ThreadRuntime(backend as never), prompt, entries };
}

function bench() {
  const delivered = deferred();
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined };
  const host = new PiHost("/repo", (event) => {
    if (event.type === "new-thread-delivery-settled") delivered.resolve();
  }, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.index.refreshShell = async () => {};
  internals.prewarm.scheduleSpare = () => {};
  internals.prewarm.takeSpare = async () => undefined;
  internals.publication.publishNewSessionUpdates = async () => {};
  internals.activateThread = async (thread: ThreadRuntime) => {
    internals.threads.setActive(thread.threadId);
    return true;
  };
  const adopt = async (thread: ThreadRuntime) => {
    await internals.threads.adopt({ threadId: thread.threadId, cwd: thread.cwd, runtime: thread, isolation: "in-process" });
  };
  return { host, internals, adopt, delivered };
}

describe("host prompt idempotency", () => {
  it.each([true, false])("shares pending and accepted submissions with journal=%s", async (journal) => {
    const { host, internals, adopt } = bench();
    const preparing = deferred();
    const release = deferred();
    internals.binding.settle = async () => { preparing.resolve(); await release.promise; };
    const { thread, prompt, entries } = fakeThread("thread", journal, async (input) => { input.onAdmitted?.(true); });
    await adopt(thread);
    const first = host.prompt("hello", [], "thread", "message");
    await preparing.promise;
    const second = host.prompt("hello", [], "thread", "message");
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
    await expect(host.prompt("hello", [], "thread", "message")).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(entries.filter((entry: any) => entry.customType === CLIENT_MESSAGE_MARKER)).toHaveLength(journal ? 1 : 0);
  });

  it("replays the original rejection without starting another turn", async () => {
    const { host, adopt } = bench();
    const error = new Error("Prompt refused");
    const { thread, prompt } = fakeThread("thread", true, async (input) => { input.onAdmitted?.(false, error); });
    await adopt(thread);
    const results = await Promise.allSettled([
      host.prompt("hello", [], "thread", "message"), host.prompt("hello", [], "thread", "message"),
    ]);
    expect(results).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
    await expect(host.prompt("hello", [], "thread", "message")).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("replays admission while the turn is still running with journal=%s", async (journal) => {
    const { host, adopt } = bench();
    const finished = deferred();
    const { thread, prompt } = fakeThread("thread", journal, async (input) => {
      input.onAdmitted?.(true);
      await finished.promise;
    });
    await adopt(thread);
    try {
      await expect(host.prompt("hello", [], "thread", "message")).resolves.toBeUndefined();
      await expect(host.prompt("hello", [], "thread", "message")).resolves.toBeUndefined();
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      finished.resolve();
    }
  });

  it("keeps distinct message ids and threads independent, and allows unidentified prompts", async () => {
    const { host, adopt } = bench();
    const first = fakeThread("first", true, async (input) => { input.onAdmitted?.(true); });
    const second = fakeThread("second", true, async (input) => { input.onAdmitted?.(true); });
    await adopt(first.thread);
    await adopt(second.thread);
    await host.prompt("hello", [], "first", "message");
    await host.prompt("hello", [], "first", "other-message");
    await host.prompt("hello", [], "second", "message");
    await host.prompt("hello", [], "first");
    await host.prompt("hello", [], "first");
    expect(first.prompt).toHaveBeenCalledTimes(4);
    expect(second.prompt).toHaveBeenCalledTimes(1);
  });

  it("replays acceptance without resolving the runtime again", async () => {
    const { host, internals, adopt } = bench();
    const { thread, prompt } = fakeThread("thread", true, async (input) => { input.onAdmitted?.(true); });
    await adopt(thread);
    await host.prompt("hello", [], "thread", "message");
    internals.awaitThread = vi.fn(async () => { throw new Error("Runtime unavailable"); });
    await expect(host.prompt("hello", [], "thread", "message")).resolves.toBeUndefined();
    expect(internals.awaitThread).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not redeliver a user message already in the journal", async () => {
    const { host, adopt } = bench();
    const { thread, prompt, entries } = fakeThread("thread", true, async (input) => { input.onAdmitted?.(true); });
    entries.push(
      { type: "custom", customType: CLIENT_MESSAGE_MARKER, data: { clientMessageId: "message", fingerprint: clientMessageFingerprint("hello", []) } },
      { type: "message", message: { role: "user", content: "hello" } },
    );
    await adopt(thread);
    await expect(host.prompt("hello", [], "thread", "message")).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns the original new-thread result and delivers its first prompt once", async () => {
    const { host, internals, delivered } = bench();
    const opening = deferred();
    const release = deferred();
    const threads: ReturnType<typeof fakeThread>[] = [];
    internals.runtimes.open = vi.fn(async () => {
      opening.resolve();
      await release.promise;
      const thread = fakeThread(`new-${threads.length}`, true, async (input) => { input.onAdmitted?.(true); });
      threads.push(thread);
      return thread.thread;
    });
    const identity = { clientTurnId: "turn", clientMessageId: "message", newThreadRequestId: createNewThreadRequestId("request") };
    const first = host.newSession("hello", [], "/repo", identity);
    await opening.promise;
    const second = host.newSession("hello", [], "/repo", identity);
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(results[0]).toMatchObject({ submission: { accepted: true } });
    expect(results[1]).toEqual(results[0]);
    await expect(host.newSession("hello", [], "/repo", identity)).resolves.toEqual(results[0]);
    await delivered.promise;
    expect(internals.runtimes.open).toHaveBeenCalledTimes(1);
    expect(threads[0].prompt).toHaveBeenCalledTimes(1);
  });
});
