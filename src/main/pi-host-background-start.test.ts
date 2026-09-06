import { describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { DEFAULT_BACKGROUND_LIMIT } from "./lifecycle-queue.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

/** A live Pi thread that records what was delivered to it. */
function fakeThread(threadId: string, delivered: string[]): ThreadRuntime {
  let hasMessages = false;
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {
      journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined },
    },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId,
      providerSessionId: threadId,
      sessionId: threadId,
      backendKind: "pi" as const,
      runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: text,
      runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push(`${threadId}:${input.text}`);
      hasMessages = true;
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({
      streaming: false,
      idle: true,
      hasMessages,
      sessionFile: `/${threadId}.jsonl`,
      activeTools: [],
      supportsImageInput: false,
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
  const runtime = {
    session: { sessionId: threadId, abort: async () => undefined, dispose: async () => undefined },
    dispose: async () => undefined,
  };
  return new ThreadRuntime(backend as never, runtime as never);
}

/** A host with one thread on screen and every background start held open. */
function hostWithHeldStarts() {
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.rememberProject = async () => {};
  internals.index.refreshShell = async () => {};
  internals.index.refresh = async () => {};
  internals.index.startRecovery = () => {};
  internals.scheduleRuntimePrewarm = () => {};
  internals.scheduleSpareThread = () => {};
  internals.projects.label = () => undefined;

  const active = fakeThread("active", delivered);
  internals.threads.adopt({ threadId: "active", cwd: "/repo", runtime: active, isolation: "in-process" });
  internals.threads.setActive("active");
  internals.cwd = "/repo";

  let opening = 0;
  let peakOpening = 0;
  const releases: Array<() => void> = [];
  let opened = 0;
  internals.runtimes.open = async () => {
    opening += 1;
    peakOpening = Math.max(peakOpening, opening);
    await new Promise<void>((resolve) => { releases.push(resolve); });
    opening -= 1;
    opened += 1;
    return fakeThread(`child-${opened}`, delivered);
  };

  const start = (title: string) => internals.startThread({ cwd: "/repo", prompt: `work on ${title}` });
  return {
    host,
    internals,
    delivered,
    start,
    releases,
    inFlight: () => opening,
    peak: () => peakOpening,
  };
}

describe("PiHost background thread starts", () => {
  it("builds several background threads at once instead of one after another", async () => {
    const bench = hostWithHeldStarts();
    const starts = Array.from({ length: 20 }, (_, index) => bench.start(`T${index}`));
    await vi.waitFor(() => { expect(bench.inFlight()).toBe(DEFAULT_BACKGROUND_LIMIT); });
    // Genuinely overlapping, and still bounded: the old queue admitted one.
    expect(bench.peak()).toBe(DEFAULT_BACKGROUND_LIMIT);
    while (bench.releases.length > 0) {
      bench.releases.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(starts);
    expect(bench.peak()).toBe(DEFAULT_BACKGROUND_LIMIT);
  });

  it("delivers a prompt to the thread on screen while background threads are being built", async () => {
    const bench = hostWithHeldStarts();
    const starts = Array.from({ length: 20 }, (_, index) => bench.start(`T${index}`));
    await vi.waitFor(() => { expect(bench.inFlight()).toBe(DEFAULT_BACKGROUND_LIMIT); });

    // Nothing has been released, so every background start still holds the lane.
    const prepared = await bench.host.preparePrompt("hello", "active");
    await bench.host.prompt("hello", [], "active", undefined, prepared);
    expect(bench.delivered).toContain("active:hello");

    while (bench.releases.length > 0) {
      bench.releases.pop()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(starts);
  });
});
