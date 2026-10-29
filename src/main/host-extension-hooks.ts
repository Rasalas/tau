import type { UiToolRun } from "../shared/contracts.js";
import type {
  HostActivationTransaction,
  HostProjectFacts,
  HostSessionFile,
  HostSessionSweep,
  HostStopReport,
  HostThread,
  HostThreadLifecycle,
  HostTurnObserver,
  HostWorkspaceCloseReason,
} from "./host-extension-contracts.js";

/** Fans one lifecycle step out to every registered hook, in registration order. */
export class HostThreadLifecycleSet {
  private readonly hooks = new Set<HostThreadLifecycle>();

  add(hook: HostThreadLifecycle): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }

  async beforeWorkspace(cwd: string): Promise<void> {
    for (const hook of [...this.hooks]) await hook.beforeWorkspace?.(cwd);
  }

  /** One hook that cannot let go must not keep the next workspace from opening. */
  async afterWorkspaceClose(cwd: string, reason: HostWorkspaceCloseReason): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.afterWorkspaceClose?.(cwd, reason); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Workspace close failed");
  }

  /** The thread is already gone, so every hook gets its turn whatever the others do. */
  async threadDeleted(sessionId: string, cwd: string): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.threadDeleted?.(sessionId, cwd); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Thread deletion cleanup failed");
  }

  async beforeOpen(session: HostSessionFile): Promise<void> {
    for (const hook of [...this.hooks]) await hook.beforeOpen?.(session);
  }

  async afterFork(source: HostThread, target: HostSessionFile): Promise<void> {
    for (const hook of [...this.hooks]) await hook.afterFork?.(source, target);
  }

  /** One transaction over every hook's; a hook failing rolls back the ones before it. */
  async beforeActivate(thread: HostThread): Promise<HostActivationTransaction | undefined> {
    const transactions: HostActivationTransaction[] = [];
    for (const hook of [...this.hooks]) {
      try {
        const transaction = await hook.beforeActivate?.(thread);
        if (transaction) transactions.push(transaction);
      } catch (error) {
        await rollbackAll(transactions).catch(() => undefined);
        throw error;
      }
    }
    if (transactions.length === 0) return undefined;
    return {
      commit: async () => { for (const transaction of transactions) await transaction.commit(); },
      rollback: () => rollbackAll(transactions),
    };
  }

  async sweep(sweep: HostSessionSweep): Promise<void> {
    const errors: unknown[] = [];
    for (const hook of [...this.hooks]) {
      try { await hook.sweep?.(sweep); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Session sweep failed");
  }
}

async function rollbackAll(transactions: readonly HostActivationTransaction[]): Promise<void> {
  const errors: unknown[] = [];
  for (const transaction of [...transactions].reverse()) {
    try { await transaction.rollback(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Activation rollback failed");
}

function phrases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((phrase): phrase is string => typeof phrase === "string" && phrase.trim().length > 0).map((phrase) => phrase.trim().slice(0, 200)) : [];
}

function stopAnswer(answer: unknown): HostStopReport {
  if (Array.isArray(answer)) return { stopped: phrases(answer), continues: [] };
  const report = answer && typeof answer === "object" ? answer as { stopped?: unknown; continues?: unknown } : {};
  return { stopped: phrases(report.stopped), continues: phrases(report.continues) };
}

/** Fans turn boundaries out to every observer; pending work is the sum of theirs. */
export class HostTurnObserverSet {
  private readonly observers = new Set<HostTurnObserver>();
  /** Prompts accepted and not ended yet; a steer or follow-up joins one and is not counted. */
  private readonly open = new Map<string, Set<string>>();
  /** How the run's prompts ended so far, until `runEnded` reports it. */
  private readonly outcomes = new Map<string, "completed" | "failed">();

  /** `afterTurn` hears each prompt that ended or was refused, after it stopped counting as open. */
  constructor(private readonly afterTurn?: (sessionId: string) => void) {}

  add(observer: HostTurnObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  /** A prompt of the thread is still on its way, so its run goes on. */
  hasOpenTurn(sessionId: string): boolean {
    return (this.open.get(sessionId)?.size ?? 0) > 0;
  }

  accepted(sessionId: string, turnId: string, options: { deferBefore: boolean; expectsInput?: boolean }): void {
    if (options.expectsInput !== false) {
      const open = this.open.get(sessionId) ?? new Set<string>();
      open.add(turnId);
      this.open.set(sessionId, open);
    }
    for (const observer of [...this.observers]) observer.accepted?.(sessionId, turnId, options);
  }

  async prepare(sessionId: string, turnId: string): Promise<void> {
    for (const observer of [...this.observers]) await observer.prepare?.(sessionId, turnId);
  }

  async cancelled(sessionId: string, turnId: string): Promise<void> {
    if (this.close(sessionId, turnId)) this.afterTurn?.(sessionId);
    for (const observer of [...this.observers]) await observer.cancelled?.(sessionId, turnId);
  }

  async ended(sessionId: string, turnId: string, outcome: "completed" | "failed"): Promise<void> {
    if (this.outcomes.get(sessionId) !== "failed") this.outcomes.set(sessionId, outcome);
    if (this.close(sessionId, turnId)) this.afterTurn?.(sessionId);
    for (const observer of [...this.observers]) await observer.ended?.(sessionId, turnId, outcome);
  }

  /** A turn the runtime began itself counts as the run's prompt when none of the host's did. */
  unpromptedEnded(sessionId: string, outcome: "completed" | "failed"): void {
    if (this.outcomes.get(sessionId) !== "failed") this.outcomes.set(sessionId, outcome);
  }

  /** The thread's run is over; observers hear it once, and only when a prompt of it ended. */
  runEnded(sessionId: string): void {
    const outcome = this.outcomes.get(sessionId);
    if (outcome === undefined) return;
    this.outcomes.delete(sessionId);
    for (const observer of [...this.observers]) observer.runEnded?.(sessionId, outcome);
  }

  private close(sessionId: string, turnId: string): boolean {
    const open = this.open.get(sessionId);
    if (!open?.delete(turnId)) return false;
    if (open.size === 0) this.open.delete(sessionId);
    return true;
  }

  pending(sessionId: string): number {
    let total = 0;
    for (const observer of this.observers) total += observer.pending?.(sessionId) ?? 0;
    return total;
  }

  async reset(sessionId: string): Promise<void> {
    // A rebound runtime ends no prompt of the one before it.
    if (this.open.delete(sessionId)) this.afterTurn?.(sessionId);
    for (const observer of [...this.observers]) await observer.reset?.(sessionId);
  }

  toolEnded(sessionId: string, tool: UiToolRun, cwd: string): void {
    for (const observer of [...this.observers]) observer.toolEnded?.(sessionId, tool, cwd);
  }

  /** Every observer hears a stop; one that fails or hangs past `timeoutMs` adds nothing to the status line. */
  async stopped(sessionId: string, timeoutMs = 2_000): Promise<HostStopReport> {
    const answers = await Promise.all([...this.observers].map(async (observer) => {
      if (!observer.stopped) return { stopped: [], continues: [] };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          Promise.resolve(observer.stopped(sessionId)),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); timer.unref?.(); }),
        ]);
        return stopAnswer(answer);
      } catch {
        return { stopped: [], continues: [] };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    return { stopped: answers.flatMap((answer) => answer.stopped), continues: answers.flatMap((answer) => answer.continues) };
  }

  /** Every observer gets to close; failures are reported together afterwards. */
  async closed(sessionId: string): Promise<void> {
    if (this.open.delete(sessionId)) this.afterTurn?.(sessionId);
    const errors: unknown[] = [];
    for (const observer of [...this.observers]) {
      try { await observer.closed?.(sessionId); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Turn observer shutdown failed");
  }
}

/** Asks every provider in turn; the first defined answer wins. */
export class HostProjectFactsSet {
  private readonly providers = new Set<HostProjectFacts>();

  add(facts: HostProjectFacts): () => void {
    this.providers.add(facts);
    return () => { this.providers.delete(facts); };
  }

  async name(cwd: string): Promise<string | undefined> {
    for (const facts of [...this.providers]) {
      const value = await facts.name?.(cwd);
      if (value) return value;
    }
    return undefined;
  }

  async label(cwd: string): Promise<string | undefined> {
    for (const facts of [...this.providers]) {
      const value = await facts.label?.(cwd);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async projectless(cwd: string): Promise<boolean> {
    for (const facts of [...this.providers]) if (await facts.projectless?.(cwd)) return true;
    return false;
  }

  async nested(cwd: string): Promise<boolean> {
    for (const facts of [...this.providers]) {
      if (await facts.nested?.(cwd)) return true;
    }
    return false;
  }

  async root(cwd: string): Promise<string | undefined> {
    for (const facts of [...this.providers]) {
      const root = await facts.root?.(cwd);
      if (root) return root;
    }
    return undefined;
  }
}
