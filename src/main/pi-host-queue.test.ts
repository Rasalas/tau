import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { UiBackgroundTask } from "../shared/contracts.js";
import { defaultHostConfigManager } from "./host-config.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { LIMIT_CONTINUATION_PROMPT } from "./thread-limits.js";
import { ThreadRuntime } from "./thread-runtime.js";

interface DeliveredPrompt { text: string; hidden?: boolean; delivery?: string }

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
    prompt: async (input: { text: string; hidden?: boolean; delivery?: string; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push({ text: input.text, ...(input.hidden ? { hidden: true } : {}), ...(input.delivery === "steer" ? { delivery: "steer" } : {}) });
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
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function host(dir?: string) {
  const userData = dir ?? await mkdtemp(join(tmpdir(), "tau-host-queue-"));
  if (!dir) dirs.push(userData);
  const delivered: DeliveredPrompt[] = [];
  const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined };
  const piHost = new PiHost("/repo", () => undefined, history as never, false, false, {
    queuedMessagesPath: join(userData, "queued-messages.json"),
    threadLimitsPath: join(userData, "thread-limits.json"),
  });
  const internals = piHost as unknown as Record<string, any>;
  internals.index.refreshShell = async () => {};
  const thread = streamedThread("thread-1", delivered);
  internals.threads.adopt({ threadId: "thread-1", cwd: "/repo", runtime: thread.runtime, isolation: "in-process" });
  internals.threads.setActive("thread-1");
  await piHost.queue.restore();
  await piHost.queue.flush();
  /** The runtime reports the end of its turn the way a streamed backend does. */
  const settle = (error?: string, limit?: { resetsAt?: number }) => {
    thread.stop();
    internals.events.backend("thread-1", { type: "turn-settled", status: error ? "error" : "completed", ...(error ? { error } : {}), ...(limit ? { limit } : {}) });
  };
  return { host: piHost, internals, delivered, settle, userData };
}

describe("PiHost queue and limits", () => {
  it("includes kit-owned background work of the attached thread", async () => {
    const bench = await host();
    const attached = bench.internals.attachedThread as ThreadRuntime;
    vi.spyOn(bench.internals.attached.session, "isAttached", "get").mockReturnValue(true);
    const remove = bench.internals.seam.services.background.provide((id: string) => id === attached.threadId
      ? { current: () => [{ id: "command", kind: "command", label: "Required command" }], stop: async () => undefined }
      : undefined);
    try {
      expect(bench.host.hasRequiredBackgroundWork()).toBe(true);
    } finally {
      remove();
      await bench.host.queue.flush();
    }
  });

  it.each(["native", "kit"] as const)("reads required %s background work on an off-screen thread before its shell is published", async (source) => {
    const bench = await host();
    const other = streamedThread("thread-2", []);
    let tasks: UiBackgroundTask[] = [{ id: "child", kind: "agent", label: "Required child" }];
    const background = { current: () => tasks, stop: async () => undefined };
    bench.internals.threads.adopt({ threadId: "thread-2", cwd: "/repo", runtime: other.runtime, isolation: "in-process" });
    const remove = source === "kit"
      ? bench.internals.seam.services.background.provide((id: string) => id === "thread-2" ? background : undefined)
      : undefined;
    if (source === "native") other.runtime.backend.capabilities.background = background;
    try {
      expect(bench.host.hasRequiredBackgroundWork()).toBe(true);
      tasks = [{ ...tasks[0]!, state: "reported" }];
      expect(bench.host.hasRequiredBackgroundWork()).toBe(true);
      tasks = [{ id: "server", kind: "command", label: "Checked service", blocksCompletion: false }];
      expect(bench.host.hasRequiredBackgroundWork()).toBe(false);
      tasks = [];
      expect(bench.host.hasRequiredBackgroundWork()).toBe(false);
    } finally {
      remove?.();
      await bench.host.queue.flush();
    }
  });

  it("queues the captured prompt before compaction and sends it once afterwards", async () => {
    const bench = await host();
    let finish!: () => void;
    const compact = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    bench.internals.threads.get("thread-1").runtime.backend.capabilities.compaction = { compact };
    const attachment = { kind: "image" as const, name: "note.png", mimeType: "image/png", data: "aGVsbG8=", size: 5 };
    const pending = bench.host.compactContext("thread-1", { text: "and how far are we?", attachments: [attachment] });
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
    expect(bench.host.queue.list("thread-1")).toMatchObject([{ text: "and how far are we?", attachments: [attachment] }]);
    await pending; // Admission returns while compaction still runs.
    expect(bench.delivered).toEqual([]);
    await bench.host.queue.pump("thread-1");
    expect(bench.delivered).toEqual([]);
    const otherDelivered: DeliveredPrompt[] = [];
    const other = streamedThread("thread-2", otherDelivered);
    bench.internals.threads.adopt({ threadId: "thread-2", cwd: "/repo", runtime: other.runtime, isolation: "in-process" });
    bench.internals.threads.setActive("thread-2");
    finish();
    await pending;
    await vi.waitFor(() => expect(bench.delivered.map((entry) => entry.text)).toEqual(["and how far are we?"]));
    expect(bench.host.queue.list("thread-1")).toEqual([]);
    expect(otherDelivered).toEqual([]);
    await bench.host.queue.flush();
  });

  it("holds the queued prompt when compaction fails instead of losing it or sending it unconditionally", async () => {
    const bench = await host();
    bench.internals.threads.get("thread-1").runtime.backend.capabilities.compaction = { compact: async () => { throw new Error("OAuth session expired"); } };
    await bench.host.compactContext("thread-1", { text: "next", attachments: [] });
    expect(bench.delivered).toEqual([]);
    expect(bench.host.queue.list("thread-1")).toMatchObject([{ text: "next" }]);
    await vi.waitFor(() => expect(bench.host.queue.isHeld("thread-1")).toBe(true));
    expect(bench.internals.threads.get("thread-1").runtime.compactionPending).toBe(false);
    await bench.host.queue.flush();
  });

  it("sends a queued message when the running turn ends", async () => {
    const bench = await host();
    await bench.host.prompt("long job", [], "thread-1");
    bench.host.queue.add("thread-1", { text: "then this", attachments: [] });
    expect(bench.delivered.map((entry) => entry.text)).toEqual(["long job"]);
    bench.settle();
    await vi.waitFor(() => expect(bench.delivered.map((entry) => entry.text)).toEqual(["long job", "then this"]));
    await bench.host.queue.flush();
  });

  it("steers a wake into the running turn, and queues it when the user wants wakes queued", async () => {
    const bench = await host();
    const wake = { source: "pull-request", label: "PR #76 · checks finished" };
    const send = (text: string) => bench.internals.hostExtensions.services.sessions.send("thread-1", text, { delivery: "queue", wake });
    await bench.host.prompt("long job", [], "thread-1");
    await send("Checks finished.");
    expect(bench.delivered.at(-1)).toEqual({ text: "[Tau wake: pull-request] PR #76 · checks finished\n\nChecks finished.", delivery: "steer" });
    expect(bench.host.queue.list("thread-1")).toEqual([]);

    vi.spyOn(defaultHostConfigManager, "readSync").mockReturnValue({ threads: { wakeDelivery: "queue" } });
    await send("Checks finished again.");
    expect(bench.host.queue.list("thread-1").map((entry) => entry.wake)).toEqual([wake]);
    expect(bench.delivered).toHaveLength(2);
    await bench.host.queue.flush();
  });

  it("queues background results without interrupting the running turn", async () => {
    const bench = await host();
    const wake = { source: "background", label: "Tests ended" };
    await bench.host.prompt("foreground job", [], "thread-1");
    await bench.internals.hostExtensions.services.sessions.send("thread-1", "Tests passed.", { delivery: "queue", wake });
    expect(bench.delivered).toEqual([{ text: "foreground job" }]);
    expect(bench.host.queue.list("thread-1").map((entry) => entry.wake)).toEqual([wake]);
    bench.settle();
    await vi.waitFor(() => expect(bench.delivered.at(-1)).toEqual({ text: "[Tau wake: background] Tests ended\n\nTests passed." }));
    await bench.host.queue.flush();
  });

  it("delivers background results after the parent turn ends while native children still run", async () => {
    const bench = await host();
    const thread = bench.internals.threadFor("thread-1") as ThreadRuntime;
    const state = thread.backend.state.bind(thread.backend);
    // Claude's idle flag also includes its native children, even with no parent turn.
    vi.spyOn(thread.backend, "state").mockImplementation(() => ({ ...state(), idle: false }));
    await bench.host.prompt("delegate work", [], "thread-1");
    await bench.internals.hostExtensions.services.sessions.send("thread-1", "Tests passed.", {
      delivery: "queue", wake: { source: "background", label: "Background command ended" },
    });
    expect(bench.delivered).toEqual([{ text: "delegate work" }]);
    bench.settle();
    await vi.waitFor(() => expect(bench.delivered.at(-1)?.text).toContain("Tests passed."));
    expect(bench.host.queue.list("thread-1")).toEqual([]);
    await bench.host.queue.flush();
  });

  it("keeps a queued message across a host restart and holds it for the user", async () => {
    const first = await host();
    await first.host.prompt("long job", [], "thread-1");
    first.host.queue.add("thread-1", { text: "after the restart", attachments: [] });
    await first.host.queue.flush();

    const second = await host(first.userData);
    await second.internals.sessionControl.reconcile();
    expect(second.host.queue.view("thread-1")).toEqual({ held: true, messages: [{ id: expect.any(String), text: "after the restart", attachments: 0 }] });
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
