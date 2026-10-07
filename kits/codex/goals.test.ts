import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import type { CodexGoal, CodexGoalStatus, CodexThreadInfo, CodexUserInput } from "./app-server.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CodexSessionStore } from "./session-store.js";
import { CodexThreadRuntimeBackend, type CodexSessionInput, type CodexSessionLike } from "./thread-backend.js";

/**
 * `thread/goal/*` as codex-cli 0.160.1 answers it (checked against the real
 * CLI with a scratch CODEX_HOME): a paused set starts no turn, every change is
 * also a `thread/goal/updated`, a clear a `thread/goal/cleared`. Codex starts
 * the next goal turn itself; the test plays that part.
 */
class FakeCodex implements CodexSessionLike {
  closed = false;
  readonly stderr = "";
  goal: CodexGoal | undefined;
  readonly calls: Array<[string, unknown]> = [];
  private turns = 0;

  constructor(private readonly input: CodexSessionInput, initial?: CodexGoal, private readonly withGoals = true) {
    this.goal = initial;
    if (!withGoals) { delete (this as Partial<CodexSessionLike>).goalGet; delete (this as Partial<CodexSessionLike>).goalSet; delete (this as Partial<CodexSessionLike>).goalClear; }
  }

  async models() { return []; }
  private info(): CodexThreadInfo { return { thread: { id: "codex-thread" }, model: "gpt-test", reasoningEffort: null }; }
  async startThread() { return this.info(); }
  async resumeThread() { return this.info(); }
  async startTurn(params: { input: CodexUserInput[] }) {
    this.turns += 1;
    const id = `turn-${this.turns}`;
    this.calls.push(["turn/start", params.input]);
    setTimeout(() => this.started(id), 0);
    return id;
  }
  async steerTurn() { return undefined; }
  async interruptTurn(_threadId: string, turnId: string) {
    this.calls.push(["turn/interrupt", turnId]);
    this.complete(turnId, "interrupted");
  }
  goalGet = async (_threadId: string) => this.goal ? { ...this.goal } : undefined;
  goalSet = async (params: { threadId: string; objective?: string; status?: CodexGoalStatus }) => {
    this.calls.push(["thread/goal/set", { ...params }]);
    const base = this.goal && (params.objective === undefined || params.objective === this.goal.objective) ? this.goal : undefined;
    this.goal = { threadId: params.threadId, objective: params.objective ?? base?.objective ?? "", status: params.status ?? base?.status ?? "active", tokenBudget: base?.tokenBudget ?? null, tokensUsed: base?.tokensUsed ?? 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 };
    this.notify("thread/goal/updated", { threadId: params.threadId, turnId: null, goal: this.goal });
    return { ...this.goal };
  };
  goalClear = async (threadId: string) => {
    this.calls.push(["thread/goal/clear", threadId]);
    const had = Boolean(this.goal);
    this.goal = undefined;
    if (had) this.notify("thread/goal/cleared", { threadId });
    return had;
  };
  async close() { this.closed = true; }

  notify(method: string, params: Record<string, unknown>) { this.input.onNotification(method, params); }
  started(id: string) { this.notify("turn/started", { threadId: "codex-thread", turn: { id } }); }
  complete(id: string, status = "completed") { this.notify("turn/completed", { threadId: "codex-thread", turn: { id, status } }); }
  /** Codex decides the goal goes on and starts its next turn. */
  continueGoal() { this.turns += 1; const id = `turn-${this.turns}`; this.started(id); return id; }
}

const dirs: string[] = [];
const backends: CodexThreadRuntimeBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Waits for what the fake and the backend do between macrotasks, however busy the machine is. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const statuses = (session: FakeCodex) => session.calls.filter(([method]) => method === "thread/goal/set").map(([, params]) => (params as { status?: string }).status);

async function open(options: { tools?: string[]; initial?: CodexGoal; withGoals?: boolean; store?: CodexSessionStore; dir?: string; resume?: boolean } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), "tau-codex-goals-"));
  if (!options.dir) dirs.push(dir);
  const store = options.store ?? new CodexSessionStore({ filePath: join(dir, "sessions.json") });
  const events: ThreadRuntimeEvent[] = [];
  const sessions: FakeCodex[] = [];
  const backend = new CodexThreadRuntimeBackend("tau-1", dir, {
    adapter: createCodexRuntimeAdapter(),
    store,
    openSession: async (input) => { const session = new FakeCodex(input, options.initial, options.withGoals ?? true); sessions.push(session); return session; },
    onEvent: (event) => events.push(event),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  backends.push(backend);
  await backend.start(options.resume ? "resume" : "create");
  return { backend, events, sessions, store, dir, session: () => sessions.at(-1)! };
}

const settled = (events: ThreadRuntimeEvent[]) => events.filter((event) => event.type === "turn-settled");

describe("Codex native goals", () => {
  it("sets a goal paused, activates it once the turn with the objective started, and holds one run across Codex's own turns", async () => {
    const { backend, events, session } = await open();
    const goals = backend.capabilities.goals!;
    await expect(goals.set("Make CI green")).resolves.toBeUndefined();
    expect(goals.current()).toMatchObject({ objective: "Make CI green", status: "paused", actions: { pause: true, resume: true } });

    const run = backend.prompt({ text: "Make CI green", delivery: "prompt" });
    await until(() => statuses(session()).length === 2);
    expect(statuses(session())).toEqual(["paused", "active"]);
    expect(goals.current()).toMatchObject({ status: "active", turns: 1 });

    session().complete("turn-1");
    await tick();
    expect(settled(events)).toEqual([]);
    expect(backend.state().idle).toBe(false);

    const next = session().continueGoal();
    await until(() => events.some((event) => event.type === "user-message"));
    expect(events).toContainEqual({ type: "user-message", message: expect.objectContaining({ role: "notice", text: "[Tau wake: goal] Goal continued · turn 2" }) });
    session().complete(next);
    await tick();
    expect(settled(events)).toEqual([]);

    await session().goalSet({ threadId: "codex-thread", status: "complete" });
    await run;
    expect(settled(events)).toEqual([{ type: "turn-settled", status: "completed" }]);
    expect(goals.current()).toMatchObject({ status: "complete", turns: 2 });
    expect((await backend.transcript()).map((message) => message.role)).toEqual(["user", "notice"]);
  });

  it("ends the run when the goal is paused between two turns, and stops a goal turn no run owns", async () => {
    const { backend, events, session } = await open();
    const goals = backend.capabilities.goals!;
    await goals.set("Keep going");
    const run = backend.prompt({ text: "Keep going", delivery: "prompt" });
    await until(() => statuses(session()).includes("active"));
    session().complete("turn-1");
    await tick();
    await goals.pause();
    await run;
    expect(settled(events)).toHaveLength(1);
    expect(goals.current()?.status).toBe("paused");

    // Codex raced the pause: a goal turn arrives with no run to own it.
    session().goal = { ...session().goal!, status: "active" };
    await session().goalSet({ threadId: "codex-thread", status: "active" });
    const stray = session().continueGoal();
    await until(() => session().calls.some(([method]) => method === "turn/interrupt"));
    expect(session().calls).toContainEqual(["turn/interrupt", stray]);
    expect(goals.current()?.status).toBe("paused");
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", level: "warning" }));
  });

  it("settles a goal run that Stop ends between two goal turns", async () => {
    const { backend, events, session } = await open();
    await backend.capabilities.goals!.set("Keep going");
    const run = backend.prompt({ text: "Keep going", delivery: "prompt" });
    await until(() => statuses(session()).includes("active"));
    session().complete("turn-1");
    await tick();
    await backend.abort();
    await run;
    expect(settled(events)).toHaveLength(1);
    expect(backend.state().idle).toBe(true);
  });

  it("resumes from rest with a goal turn of its own and no user message", async () => {
    const { backend, events, session } = await open();
    const goals = backend.capabilities.goals!;
    await goals.set("Again");
    await goals.resume();
    await until(() => statuses(session()).includes("active"));
    expect(session().calls).toContainEqual(["turn/start", []]);
    expect(goals.current()?.status).toBe("active");
    expect(events).toContainEqual({ type: "user-message", message: expect.objectContaining({ role: "notice", text: "[Tau wake: goal] Goal resumed · turn 1" }) });
    expect(events.some((event) => event.type === "user-message" && event.message.role === "user")).toBe(false);
    await goals.clear();
    session().complete("turn-1");
    // The run settles after the turn's completion is handled, not within a fixed tick.
    await until(() => backend.state().idle);
    expect(goals.current()).toBeUndefined();
  });

  it("pauses an active goal it finds after a restart before showing it, and keeps it in the record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-codex-goals-"));
    dirs.push(dir);
    const store = new CodexSessionStore({ filePath: join(dir, "sessions.json") });
    await store.ensure("tau-1", dir);
    await store.setCodexThread("tau-1", dir, "codex-thread");
    await store.setGoal("tau-1", dir, { objective: "Ship", status: "active", tokensUsed: 10, turns: 3, updatedAt: 1 });
    const initial: CodexGoal = { threadId: "codex-thread", objective: "Ship", status: "active", tokenBudget: 5000, tokensUsed: 12, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 };
    const { backend, events, session } = await open({ dir, store, initial, resume: true });
    expect(events).toContainEqual({ type: "goal" });
    await until(() => backend.capabilities.goals!.current()?.status === "paused");
    expect(session().calls).toContainEqual(["thread/goal/set", { threadId: "codex-thread", status: "paused" }]);
    expect(backend.capabilities.goals!.current()).toMatchObject({ status: "paused", tokensUsed: 12, tokenBudget: 5000, turns: 3 });
    expect((await store.get("tau-1"))?.goal).toMatchObject({ status: "paused", turns: 3 });
  });

  it("offers no goals in a thread restricted to some tools, nor on a CLI without them", async () => {
    const restricted = await open({ tools: ["read"] });
    expect(restricted.backend.capabilities.goals).toBeUndefined();
    const old = await open({ withGoals: false });
    expect(old.backend.capabilities.goals).toBeDefined();
    // The session opens with the first turn; a CLI that answers no goal methods takes the capability away.
    const run = old.backend.prompt({ text: "hi", delivery: "prompt" });
    await until(() => old.sessions.length > 0 && old.session().calls.length > 0);
    old.session().complete("turn-1");
    await run;
    expect(old.backend.capabilities.goals).toBeUndefined();
    expect(old.events).toContainEqual({ type: "goal" });
  });
});
