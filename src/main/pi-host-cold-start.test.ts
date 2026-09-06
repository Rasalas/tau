import { describe, expect, it } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

/** A blank Pi thread, like the one a cold start opens before anything is sent. */
function blankThread(threadId: string, delivered: string[]): ThreadRuntime {
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
      delivered.push(input.text);
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
  return new ThreadRuntime(backend as never, { session: { sessionId: threadId } } as never);
}

/** A host whose initial runtime opens only when the test releases it. */
function coldHost(delivered: string[]) {
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  const thread = blankThread("cold-thread", delivered);
  let release!: () => void;
  const opening = new Promise<void>((resolve) => { release = resolve; });
  internals.activateHostExtensions = async () => {};
  internals.rememberProject = async () => {};
  internals.attached.session.attach = async () => false;
  internals.openInitialThread = async () => { await opening; return thread; };
  internals.index.refreshShell = async () => {};
  internals.index.refresh = async () => {};
  internals.index.startRecovery = () => {};
  internals.scheduleRuntimePrewarm = () => {};
  internals.scheduleSpareThread = () => {};
  internals.projects.label = () => undefined;
  internals.bootstrap = async () => ({ version: 1 });
  return { host, internals, thread, release: () => release() };
}

describe("PiHost cold start", () => {
  it("delivers a first message named against a cached thread id to the thread the run opened", async () => {
    const delivered: string[] = [];
    const { host, release } = coldHost(delivered);

    const started = host.start();
    // The renderer paints from its bootstrap cache and names last run's thread.
    const prepared = host.preparePrompt("first message", "thread-from-the-previous-run");
    release();
    await started;

    await expect(prepared).resolves.toMatchObject({ visibleText: "first message", tauThreadId: "cold-thread" });
    await host.prompt("first message", [], "thread-from-the-previous-run", undefined, await prepared);
    expect(delivered).toEqual(["first message"]);
  });

  it("waits for a thread that is still opening instead of refusing it", async () => {
    const delivered: string[] = [];
    const { host, release } = coldHost(delivered);

    const started = host.start();
    const prepared = host.preparePrompt("hello", "cold-thread");
    release();
    await started;

    await expect(prepared).resolves.toMatchObject({ tauThreadId: "cold-thread" });
  });

  it("still refuses a prompt for a thread it knows but does not have open", async () => {
    const delivered: string[] = [];
    const { host, internals, release } = coldHost(delivered);

    const started = host.start();
    release();
    await started;
    internals.index.sessions = [{
      id: "archived-thread",
      path: "/archived-thread.jsonl",
      title: "Archived",
      modifiedAt: 1,
      projectPath: "/repo",
      projectName: "repo",
      messageCount: 2,
    }];

    await expect(host.preparePrompt("hello", "archived-thread"))
      .rejects.toThrow("That thread is not open any more.");
    expect(delivered).toEqual([]);
  });
});
