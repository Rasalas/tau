import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { HostBackendOpenContext, HostExtension, HostTurnObserverSet } from "./host-extensions.js";
import { HostStart } from "./host-start.js";
import { PiHost } from "./pi-host.js";
import { ProjectHistory } from "./project-history.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ThreadRuntimeBackend } from "./runtime-types.js";
import { LIMIT_CONTINUATION_PROMPT, RESUME_MARGIN_MS } from "./thread-limits.js";
import { RESTART_CONTINUATION_PROMPT } from "./turn-reconciliation.js";
import type { TurnsInFlight } from "./turns-in-flight.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
const adapter: AgentRuntimeAdapter = { id: "recovery-fixture", capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } };

/** Real host startup and stores, with only the runtime provider replaced. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-host-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const cwd = join(root, "project");
  await Promise.all([cwd, join(root, "agent"), join(root, "sessions")].map((path) => mkdir(path)));
  for (const [key, path] of Object.entries({ PI_CODING_AGENT_DIR: "agent", PI_CODING_AGENT_SESSION_DIR: "sessions", TAU_CONFIG_FILE: "config.json", TAU_THEMES_DIR: "themes", TAU_PACKAGES_HOME: "packages" })) vi.stubEnv(key, join(root, path));
  vi.stubEnv("TAU_NO_WATCH", "1");
  vi.stubEnv("TAU_NO_RUNTIME_UPDATES", "1");
  const journalEntries: unknown[] = [];
  const start = async (options: { beforeIndex?: () => Promise<void>; beforeNotice?: () => Promise<void>; journal?: boolean } = {}) => {
    const delivered: Array<{ text: string; hidden: boolean }> = [];
    const notice = vi.fn(async () => { await options.beforeNotice?.(); });
    let streaming = false;
    const attempts: string[] = [];
    const aborts: string[] = [];
    let admissionGate: Promise<void> | undefined;
    let rejectAdmission: (() => void) | undefined;
    const blockNextAdmission = () => {
      admissionGate = new Promise<void>((_resolve, reject) => { rejectAdmission = () => reject(new Error("Fixture runtime stopped before admission")); });
    };
    let events!: HostBackendOpenContext;
    const idleWaiters = new Set<() => void>();
    const kit: HostExtension = {
      id: "test.recovery", name: "Recovery fixture", permissions: ["runtime:extend"],
      activate: ({ services }) => {
        const record = { threadId: "saved", cwd, title: "Saved", updatedAt: 1, messages: [{ role: "user" as const, text: "earlier" }] };
        return services.registerRuntimeBackend({
          kind: adapter.id, adapter, listThreads: async () => [record], lookup: async (id) => id === "saved" ? record : undefined, composerCommands: () => [],
          open: async (threadId, workspace, _options, context): Promise<ThreadRuntimeBackend> => {
            events = context;
            return {
              kind: adapter.id, runtimeAdapter: adapter, threadId, providerSessionId: threadId, cwd: workspace, turnReporting: "streamed",
              capabilities: {
                resume: { hiddenPrompt: true, notice },
                ...(options.journal ? { journal: { entries: () => journalEntries, appendCustomEntry: () => undefined, appendMessage: (message: unknown) => { journalEntries.push({ type: "message", message }); } } } : {}),
              },
              start: async () => undefined, dispose: async () => undefined,
              waitForIdle: async () => { if (streaming) await new Promise<void>((resolve) => idleWaiters.add(resolve)); },
              state: () => ({ streaming, idle: !streaming, hasMessages: true, title: "Saved", activeTools: [], supportsImageInput: true, extensionCount: 0 }),
              preparePrompt: async (text) => ({ tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId, backendKind: adapter.id, runtimeCapabilities: adapter.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []) }),
              prompt: async (input) => {
                attempts.push(input.text);
                if (admissionGate) { const gate = admissionGate; admissionGate = undefined; await gate; }
                delivered.push({ text: input.text, hidden: input.hidden === true });
                streaming = true;
                input.onAdmitted?.(true);
                if (input.queued || input.delivery !== "prompt") return {};
                await new Promise<void>((resolve) => idleWaiters.add(resolve));
                return {};
              },
              abort: async () => { aborts.push(threadId); rejectAdmission?.(); streaming = false; for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); },
              transcript: async () => [], persist: async () => undefined, setTitle: async () => undefined,
              catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }), models: async () => [], composerCommands: () => [],
            };
          },
        });
      },
    };
    const history = new ProjectHistory(join(root, "projects.json"));
    await history.load();
    const host = new PiHost(cwd, () => undefined, history, false, false, {
      defaultBackendKind: adapter.id, hostExtensions: [kit], kitStateDir: join(root, "kit-state"),
      queuedMessagesPath: join(root, "queue.json"), threadLimitsPath: join(root, "limits.json"), turnsInFlightPath: join(root, "turns.json"),
      createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never,
    });
    const { turnsInFlight, turnObservers } = host as unknown as { turnsInFlight: TurnsInFlight; turnObservers: HostTurnObserverSet };
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      await host.dispose();
      await Promise.all([turnsInFlight.flush(), host.queue.flush(), host.limits.flush()]);
    };
    cleanups.push(dispose);
    const beforeIndex = options.beforeIndex;
    if (beforeIndex) {
      const { index } = host as unknown as { index: { refresh(reason: "index"): Promise<unknown> } };
      const refresh = index.refresh.bind(index);
      vi.spyOn(index, "refresh").mockImplementationOnce(async (reason) => { await beforeIndex(); return refresh(reason); });
    }
    const bootstrap = vi.spyOn(host, "bootstrap");
    const startup = new HostStart(() => host);
    const ready = startup.require();
    if (!options.beforeIndex && !options.beforeNotice) await ready;
    const settle = (error?: string, resetsAt?: number) => {
      streaming = false;
      events.onEvent({ type: "turn-settled", status: error ? "error" : "completed", ...(error ? { error, limit: { resetsAt } } : {}) });
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    };
    return { host, startup, ready, bootstrap, aborts, delivered, attempts, notice, turnsInFlight, turnObservers, blockNextAdmission, settle, dispose,
      ask: () => events.ask({ kind: "confirm", title: "Approve this work?" }),
      texts: () => delivered.map((entry) => entry.text) };
  };
  return { root, cwd, start, journalEntries };
}

describe("host durable recovery through public operations", () => {
  it.each([false, true])("caps consecutive restart continuations and resets after a user message, journal=%s", async (journal) => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    let running = await f.start({ journal });
    await running.host.prompt("work that keeps crashing", [], "saved");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await running.dispose();
      running = await f.start({ journal });
      expect(running.texts()).toEqual([RESTART_CONTINUATION_PROMPT]);
    }
    running.host.queue.add("saved", { text: "retained follow-up", attachments: [] });
    await running.dispose();
    const stopped = await f.start({ journal });
    expect(stopped.texts()).toEqual([]);
    expect(stopped.notice).toHaveBeenCalledWith(expect.stringContaining("Stopped after 3 automatic continuations"));
    expect((await stopped.host.bootstrap()).threadIndex.sessions).toContainEqual(expect.objectContaining({ id: "saved", interrupted: true }));
    expect(stopped.host.queue.view("saved")?.held).toBe(true);
    await stopped.host.prompt("try again with my correction", [], "saved");
    await stopped.dispose();
    const reset = await f.start({ journal });
    expect(reset.texts()).toEqual([RESTART_CONTINUATION_PROMPT]);
  });

  it.each([0, 1])("leaves a thread awaiting an answer interrupted after restart, answered=%s", async (answered) => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    const first = await f.start();
    await first.host.prompt("work needing approval", [], "saved");
    const answers = [first.ask()];
    if (answered) {
      answers.push(first.ask());
      first.host.answerExtensionUi(first.host.replayOpenUiPrompts()[0]!.id, { confirmed: true });
    }
    await first.turnsInFlight.flush();
    await first.dispose();
    await Promise.all(answers);
    const second = await f.start();
    expect(second.texts()).toEqual([]);
    expect(second.notice).toHaveBeenCalledWith(expect.stringContaining("waiting for your answer"));
    expect((await second.host.bootstrap()).threadIndex.sessions).toContainEqual(expect.objectContaining({ id: "saved", interrupted: true }));
  });

  it.each([false, true])("resets the chain when a user steers a running continuation, journal=%s", async (journal) => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    await writeFile(join(f.root, "turns.json"), JSON.stringify({ version: 1, turns: [{
      sessionId: "saved", cwd: f.cwd, turnId: "previous", backend: adapter.id,
      startedAt: 1, prompt: { text: "unfinished" }, continuationCount: 2,
    }] }));
    const first = await f.start({ journal });
    expect(first.texts()).toEqual([RESTART_CONTINUATION_PROMPT]);
    await first.host.steer("use this correction", [], "saved");
    await first.dispose();
    const second = await f.start({ journal });
    expect(second.texts()).toEqual([RESTART_CONTINUATION_PROMPT]);
  });

  it("continues after all questions were answered before the restart", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    const first = await f.start();
    await first.host.prompt("work needing approvals", [], "saved");
    const answers = [first.ask(), first.ask()];
    const prompts = first.host.replayOpenUiPrompts();
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) first.host.answerExtensionUi(prompt.id, { confirmed: true });
    await Promise.all(answers);
    await first.dispose();
    const second = await f.start();
    expect(second.texts()).toEqual([RESTART_CONTINUATION_PROMPT]);
  });

  it("recovers the running turn after a queued prompt returns and the host stops", async () => {
    const f = await fixture();
    const first = await f.start({ journal: true });
    await first.host.prompt("turn A", [], "saved");
    const marker = first.turnsInFlight.get("saved");
    expect(marker?.prompt.text).toBe("turn A");
    let queuedReturned!: () => void;
    const queued = new Promise<void>((resolve) => { queuedReturned = resolve; });
    first.turnObservers.add({ ended: async () => { queuedReturned(); } });
    await first.host.prompt("turn B", [], "saved");
    await queued;
    await first.turnsInFlight.flush();
    expect(first.turnsInFlight.get("saved")).toEqual(marker);
    f.journalEntries.push({ type: "message", message: {
      role: "assistant", content: [{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }],
    } });
    // Shutdown freezes the same durable markers a crash leaves behind.
    await first.dispose();
    const second = await f.start({ journal: true });
    expect((await second.host.bootstrap()).threadIndex.sessions).toContainEqual(expect.objectContaining({
      id: "saved", interrupted: true,
    }));
    expect(second.notice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Interrupted by a restart"));
    expect(f.journalEntries).toContainEqual({ type: "message", message: expect.objectContaining({
      role: "toolResult", toolCallId: "unfinished", isError: true,
    }) });
    expect(second.texts()).toEqual([]);
    expect(second.turnsInFlight.list()).toEqual([]);
  });

  it.each(["accepted", "prepare"] as const)("cancels a turn and its durable marker when %s rejects", async (phase) => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    const first = await f.start({ journal: true });
    const error = new Error("Preparation refused");
    const cancelled = vi.fn();
    first.turnObservers.add({ [phase]: () => { throw error; }, cancelled });
    await expect(first.host.prompt("never admitted", [], "saved")).rejects.toBe(error);
    expect(first.turnObservers.hasOpenTurn("saved")).toBe(false);
    expect(first.turnsInFlight.list()).toEqual([]);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("saved", expect.any(String));
    expect(first.attempts).toEqual([]);
    await first.dispose();
    const second = await f.start({ journal: true });
    expect(second.notice).not.toHaveBeenCalled();
    expect(second.texts()).toEqual([]);
  });

  it.each(["index", "recovery"] as const)("holds client sends during %s and retains old and new follow-ups exactly once", async (phase) => {
    const f = await fixture();
    await writeFile(join(f.root, "turns.json"), JSON.stringify({ version: 1, turns: [{ sessionId: "saved", cwd: f.cwd, turnId: "interrupted-turn", backend: adapter.id, startedAt: 1, prompt: { text: "unfinished" } }] }));
    await writeFile(join(f.root, "queue.json"), JSON.stringify({ version: 1, threads: { saved: [{ id: "retained", text: "older follow-up", attachments: [], queuedAt: 1 }] } }));
    let entered!: () => void;
    const indexing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const listing = new Promise<void>((resolve) => { release = resolve; });
    const gate = async () => { entered(); await listing; };
    const b = await f.start({ journal: true, ...(phase === "index" ? { beforeIndex: gate } : { beforeNotice: gate }) });
    await indexing;
    const sent = b.startup.require().then((host) => host.prompt("new work", [], "saved"));
    const queued = sent.then(() => b.startup.require()).then((host) => host.queue.submit("saved", { text: "new follow-up", attachments: [] }));
    try {
      expect(b.bootstrap).not.toHaveBeenCalled();
      expect(b.texts()).toEqual([]);
    } finally { release(); await Promise.all([b.ready, sent, queued]); }
    expect(b.texts()).toEqual(["new work"]);
    expect(b.aborts).toEqual([]);
    expect(b.host.queue.list("saved").map((message) => message.text)).toEqual(["older follow-up", "new follow-up"]);
    await b.host.queue.flush();
    expect(JSON.parse(await readFile(join(f.root, "queue.json"), "utf8")).threads.saved.map((message: { text: string }) => message.text)).toEqual(["older follow-up", "new follow-up"]);
    await b.dispose();
    const turns = JSON.parse(await readFile(join(f.root, "turns.json"), "utf8")).turns;
    expect(turns).toEqual([expect.objectContaining({ sessionId: "saved", prompt: { text: "new work" } })]);
    expect(turns[0].turnId).not.toBe("interrupted-turn");
  });

  it("retains the queue head across restart when a later add persists during blocked admission", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "head awaiting admission", attachments: [] });
    await first.host.queue.flush();
    first.blockNextAdmission();
    first.settle();
    await expect.poll(() => first.attempts).toEqual(["running", "head awaiting admission"]);
    first.host.queue.add("saved", { text: "later follow-up", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({
      held: true, messages: [{ text: "head awaiting admission" }, { text: "later follow-up" }],
    });
    expect(second.texts()).toEqual([]);
  });

  it("retains one copy of a rejected queue head after restart", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "reject this admission", attachments: [] });
    first.host.queue.add("saved", { text: "later follow-up", attachments: [] });
    await first.host.queue.flush();
    first.blockNextAdmission();
    first.settle();
    await expect.poll(() => first.attempts).toEqual(["running", "reject this admission"]);
    await first.host.abort("saved");
    await expect.poll(() => first.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "reject this admission" }, { text: "later follow-up" }] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "reject this admission" }, { text: "later follow-up" }] });
  });

  it("does not recover a new prompt accepted while the startup index is loading", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    await writeFile(join(f.root, "queue.json"), JSON.stringify({ version: 1, threads: { saved: [{ id: "retained", text: "older follow-up", attachments: [], queuedAt: 1 }] } }));
    const b = await f.start();
    await b.host.prompt("newly accepted work", [], "saved");
    await expect.poll(() => b.host.queue.view("saved")?.messages.length).toBe(1);
    expect(b.texts()).toEqual(["newly accepted work"]);
  });

  it("holds a limited queue through restart until its scheduled reset continuation settles", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("limited job", [], "saved");
    first.host.queue.add("saved", { text: "after reset", attachments: [] });
    first.settle("Usage limit reached", Date.now() + 60_000);
    expect(first.host.queue.view("saved")?.held).toBe(true);
    const scheduled = first.host.limits.resumeAtReset("saved");
    await first.host.queue.flush();
    await first.host.limits.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.limits.get("saved")?.resumeAt).toBe(scheduled.resumeAt);
    expect(second.host.queue.view("saved")?.held).toBe(true);
    expect(second.texts()).toEqual([]);
    // Only the timer is fake. Store reads and runtime admission remain real.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      // Re-arm through the public operation so the restored reset uses this clock.
      second.host.limits.resumeAtReset("saved");
      await vi.advanceTimersByTimeAsync(120_000 + RESUME_MARGIN_MS);
      expect(second.delivered).toEqual([{ text: LIMIT_CONTINUATION_PROMPT, hidden: true }]);
    } finally { vi.useRealTimers(); }
    second.settle();
    await expect.poll(second.texts).toEqual([LIMIT_CONTINUATION_PROMPT, "after reset"]);
    await second.host.queue.flush();
  });

  it("continues interrupted work before its retained follow-ups", async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".tau"));
    await writeFile(join(f.cwd, ".tau", "config.json"), JSON.stringify({ threads: { continueAfterRestart: true } }));
    const first = await f.start();
    await first.host.prompt("unfinished job", [], "saved");
    first.host.queue.add("saved", { text: "after continuation", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(second.texts).toEqual([RESTART_CONTINUATION_PROMPT]);
    await expect.poll(() => second.host.queue.view("saved")?.held).toBe(false);
    expect(second.delivered).toEqual([{ text: RESTART_CONTINUATION_PROMPT, hidden: true }]);
    second.settle();
    await expect.poll(second.texts).toEqual([RESTART_CONTINUATION_PROMPT, "after continuation"]);
    await second.host.queue.flush();
  });

  it("holds accepted follow-ups after restart, then sends the retained order exactly once", async () => {
    const f = await fixture();
    const first = await f.start();
    await first.host.prompt("running", [], "saved");
    first.host.queue.add("saved", { text: "first follow-up", attachments: [] });
    first.host.queue.add("saved", { text: "second follow-up", attachments: [] });
    await first.host.queue.flush();
    await first.dispose();
    const second = await f.start();
    await expect.poll(() => second.host.queue.view("saved")).toMatchObject({ held: true, messages: [{ text: "first follow-up" }, { text: "second follow-up" }] });
    second.settle();
    expect(second.texts()).toEqual([]);
    await second.host.prompt("resume explicitly", [], "saved");
    second.settle();
    second.settle();
    await expect.poll(second.texts).toEqual(["resume explicitly", "first follow-up"]);
    second.settle();
    await expect.poll(second.texts).toEqual(["resume explicitly", "first follow-up", "second follow-up"]);
    expect(second.host.queue.view("saved")).toBeUndefined();
    await second.host.queue.flush();
  });
});
