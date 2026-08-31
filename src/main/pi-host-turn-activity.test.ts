import { describe, expect, it } from "vitest";
import { cleanThreadTitle, lastTurnActivityFromMessages, PiHost } from "./pi-host.js";

describe("cleanThreadTitle", () => {
  it("removes Markdown and title-model framing", () => {
    expect(cleanThreadTitle("## **Thread title: `Persist Turn Activity`**\nExtra explanation")).toBe("Persist Turn Activity");
    expect(cleanThreadTitle("Titel: [Sidebar-Namen](https://example.test)."))
      .toBe("Sidebar-Namen");
  });
});

describe("PiHost.generateThreadTitle", () => {
  it("waits for a new thread's active first run before generating its title", async () => {
    let streaming = true;
    let finishRun!: () => void;
    const runFinished = new Promise<void>((resolve) => { finishRun = resolve; });
    const callOrder: string[] = [];
    const session = {
      sessionId: "session",
      get isStreaming() { return streaming; },
      sessionName: undefined as string | undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "Fix automatic titles" }], timestamp: 1 }],
      waitForIdle: async () => {
        callOrder.push("wait");
        await runFinished;
        streaming = false;
      },
      modelRuntime: {
        getModel: () => ({ provider: "provider", id: "model" }),
        completeSimple: async () => {
          callOrder.push("complete");
          return { stopReason: "stop", content: [{ type: "text", text: "Automatic Thread Titles" }] };
        },
      },
      sessionManager: { getBranch: () => [] },
      setSessionName: (title: string) => { session.sessionName = title; },
    };
    const thread = { session, sessionId: "session", cwd: "/repo" };
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ sessionId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.sessions = [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 }];

    const generated = host.generateThreadTitle("provider", "model", false, "session");
    await Promise.resolve();
    expect(callOrder).toEqual(["wait"]);

    finishRun();
    await expect(generated).resolves.toMatchObject({
      updates: [{ type: "thread-shell", update: { sessionId: "session", shell: { title: "Automatic Thread Titles" } } }],
    });
    expect(callOrder).toEqual(["wait", "complete"]);
  });

  it("does not let a stale new-thread activation replace a newer live switch", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      beginActivation(): number;
      activateThread(thread: unknown, touch: boolean, epoch: number): Promise<boolean>;
      threads: { adopt(record: unknown): Promise<void>; active?: { runtime: unknown; sessionId: string }; setActive(sessionId: string): void };
      rememberProject(cwd: string): Promise<void>;
      refreshThreadShell(thread: unknown, touch: boolean): Promise<void>;
      scheduleRuntimePrewarm(): void;
      scheduleSpareThread(cwd: string): void;
    };
    const makeThread = (sessionId: string) => ({
      sessionId,
      cwd: "/repo",
      session: {
        sessionId,
        sessionFile: `/${sessionId}.jsonl`,
        resourceLoader: { getExtensions: () => ({ extensions: [] }) },
      },
    });
    const staleThread = makeThread("new-thread");
    const liveThread = makeThread("live-thread");
    await internals.threads.adopt({ sessionId: staleThread.sessionId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ sessionId: liveThread.sessionId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    internals.rememberProject = async () => {
      if (internals.threads.active?.runtime === staleThread) {
        staleEntered();
        await staleGate;
      }
    };
    internals.refreshThreadShell = async () => {};
    internals.scheduleRuntimePrewarm = () => {};
    internals.scheduleSpareThread = () => {};

    const staleEpoch = internals.beginActivation();
    const staleActivation = internals.activateThread(staleThread, true, staleEpoch);
    await staleStarted;
    const liveEpoch = internals.beginActivation();
    await expect(internals.activateThread(liveThread, false, liveEpoch)).resolves.toBe(true);
    releaseStale();

    await expect(staleActivation).resolves.toBe(false);
    expect(internals.threads.active?.sessionId).toBe("live-thread");
  });

  it("guards the real newSession result when a newer live switch wins", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const makeThread = (sessionId: string, sessionFile: string) => ({
      sessionId,
      sessionFile,
      cwd: "/repo",
      session: {
        sessionId,
        sessionFile,
        resourceLoader: { getExtensions: () => ({ extensions: [] }) },
      },
    });
    const staleThread = makeThread("new-thread", "/new.jsonl");
    const liveThread = makeThread("live-thread", "/live.jsonl");
    await internals.threads.adopt({ sessionId: staleThread.sessionId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ sessionId: liveThread.sessionId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseStale!: () => void;
    let staleEntered!: () => void;
    const staleStarted = new Promise<void>((resolve) => { staleEntered = resolve; });
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    internals.rememberProject = async () => {
      if (internals.threads.active?.runtime === staleThread) {
        staleEntered();
        await staleGate;
      }
    };
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takeSpareThread = async () => undefined;
    internals.openThread = async () => staleThread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    internals.threads.release = async () => {};

    const staleNewSession = host.newSession("stale prompt", [], "/repo");
    await staleStarted;
    await expect(host.switchSession("/live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseStale();

    await expect(staleNewSession).resolves.toEqual({ version: 1, updates: [] });
    expect(internals.threads.active?.sessionId).toBe("live-thread");
  });

  it("admits newSession before the lifecycle queue so a later live switch wins", async () => {
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as Record<string, any>;
    const makeThread = (sessionId: string, sessionFile: string) => ({
      sessionId,
      sessionFile,
      cwd: "/repo",
      session: {
        sessionId,
        sessionFile,
        resourceLoader: { getExtensions: () => ({ extensions: [] }) },
      },
    });
    const staleThread = makeThread("queued-new-thread", "/queued-new.jsonl");
    const liveThread = makeThread("warm-live-thread", "/warm-live.jsonl");
    await internals.threads.adopt({ sessionId: staleThread.sessionId, cwd: staleThread.cwd, runtime: staleThread, isolation: "in-process" });
    await internals.threads.adopt({ sessionId: liveThread.sessionId, cwd: liveThread.cwd, runtime: liveThread, isolation: "in-process" });

    let releaseLifecycle!: () => void;
    internals.lifecycleQueue = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
    internals.rememberProject = async () => {};
    internals.refreshThreadShell = async () => {};
    internals.detachBridge = () => {};
    internals.takeSpareThread = async () => undefined;
    internals.openThread = async () => staleThread;
    internals.logReplacement = () => {};
    internals.scheduleSpareThread = () => {};
    internals.activeUpdates = async () => ({ version: 1, updates: [] });
    internals.threads.release = async () => {};
    const prompts: string[] = [];
    internals.prompt = async (text: string) => { prompts.push(text); };

    const queuedNewSession = host.newSession("must not be sent", [], "/repo");
    await expect(host.switchSession("/warm-live.jsonl")).resolves.toEqual({ version: 1, updates: [] });
    releaseLifecycle();

    await expect(queuedNewSession).resolves.toEqual({ version: 1, updates: [] });
    expect(prompts).toEqual([]);
    expect(internals.threads.active?.sessionId).toBe("warm-live-thread");
  });
});

describe("lastTurnActivityFromMessages", () => {
  it("reconstructs completed tools and their transcript anchor", () => {
    const activity = lastTurnActivityFromMessages([
      { role: "user", content: [{ type: "text", text: "older" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "change it" }], timestamp: 3, tauEntryId: "entry-user" },
      { role: "assistant", content: [{ type: "thinking", thinking: "work" }, { type: "toolCall", id: "call", name: "edit", arguments: { path: "/repo/src/a.ts" } }], timestamp: 4 },
      { role: "toolResult", toolCallId: "call", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "finished" }], timestamp: 6 },
    ]);

    expect(activity).toEqual({
      anchorMessageId: "entry-user",
      tools: [{
        id: "call",
        name: "edit",
        args: { path: "/repo/src/a.ts" },
        status: "done",
        output: "done",
        startedAt: 4,
        endedAt: 5,
      }],
    });
  });
});
