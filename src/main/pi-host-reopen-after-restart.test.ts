import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

function fakeThread(threadId: string, delivered: string[]): ThreadRuntime {
  let hasMessages = threadId !== "initial";
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
      sessionFile: `/sessions/${threadId}.jsonl`,
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

const saved: SessionInfo = {
  path: "/sessions/saved.jsonl",
  id: "saved",
  cwd: "/repo",
  created: new Date(1),
  modified: new Date(2),
  messageCount: 2,
  firstMessage: "earlier",
  allMessagesText: "earlier",
};

/**
 * A host just restarted: its first pass over the session files is still
 * reading them when a send for a thread from the last run comes in.
 */
function restartedHost() {
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  let finishListing!: () => void;
  const listing = new Promise<void>((resolve) => { finishListing = resolve; });
  vi.spyOn(SessionManager, "listAll").mockImplementation(async () => { await listing; return [saved]; });
  internals.activateHostExtensions = async () => {};
  internals.rememberProject = async () => {};
  internals.attached.session.attach = async () => false;
  internals.openInitialThread = async () => fakeThread("initial", delivered);
  internals.index.refreshShell = async () => {};
  internals.index.startRecovery = () => {};
  internals.trash.start = () => {};
  internals.reconcileInterruptedTurns = async () => {};
  internals.catalogs.start = () => {};
  internals.prewarm.scheduleThreads = () => {};
  internals.prewarm.scheduleSpare = () => {};
  internals.projects.label = () => undefined;
  internals.bootstrap = async () => ({ version: 1 });
  const opened: string[] = [];
  internals.runtimes.openForPath = async (path: string) => {
    opened.push(path);
    const thread = fakeThread("saved", delivered);
    internals.threads.adopt({ threadId: "saved", cwd: "/repo", runtime: thread, isolation: "in-process" });
    return thread;
  };
  return { host, internals, delivered, opened, finishListing: () => finishListing() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("PiHost after a restart", () => {
  it("delivers a send to a saved thread that arrives before the session files are indexed", async () => {
    const bench = restartedHost();
    await bench.host.start();

    const sent = bench.internals.sendToThread("saved", "say one word", "prompt") as Promise<void>;
    const outcome = sent.then(() => "sent", (error: Error) => error.message);
    await Promise.resolve();
    bench.finishListing();

    await expect(outcome).resolves.toBe("sent");
    expect(bench.opened).toEqual(["/sessions/saved.jsonl"]);
    expect(bench.delivered).toEqual(["saved:say one word"]);
  });

  it("still refuses a thread the indexed session files do not hold", async () => {
    const bench = restartedHost();
    await bench.host.start();
    bench.finishListing();

    await expect(bench.internals.sendToThread("gone", "hello", "prompt")).rejects.toThrow("That thread no longer exists.");
    expect(bench.opened).toEqual([]);
  });
});
