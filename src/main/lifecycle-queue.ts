import { AsyncLocalStorage } from "node:async_hooks";

/** Background operations that may hold the queue together. */
export const DEFAULT_BACKGROUND_LIMIT = 4;

export interface LifecycleQueueOptions {
  /** How long an operation may hold the queue before it is reported. */
  slowAfterMs?: number;
  /** How many background operations run at once; exclusive ones still exclude them all. */
  backgroundLimit?: number;
  /** Reports a long-running operation; the operation is never aborted. */
  onSlow?(operation: string, elapsedMs: number): void;
  now?(): number;
}

interface Admission {
  background: boolean;
  admit(): void;
}

/**
 * Serialises the host's thread lifecycle work: opening, switching, forking and
 * disposing threads never interleave.
 *
 * `runBackground` is the one exception, for work that only touches the thread
 * it is creating: a bounded number of those run together, so fifty sub-agents
 * do not start one after another behind a queue meant to protect the thread on
 * screen. An exclusive operation still excludes every background one, in both
 * directions, and admission is FIFO, so neither side starves the other.
 *
 * An operation started while the caller is already inside the queue runs
 * inline instead of enqueuing itself. That is what keeps a lifecycle hook - or
 * an extension calling `sessions.exclusive` from one - from waiting for the
 * operation it is itself part of, the deadlock ADR 0004 was written about.
 */
export class LifecycleQueue {
  private readonly waiting: Admission[] = [];
  private exclusiveRunning = false;
  private backgroundRunning = 0;
  /** The token is invalidated when its operation ends, so a callback created inside an operation but fired later queues normally. */
  private readonly inside = new AsyncLocalStorage<{ name: string; active: boolean }>();
  private readonly slowAfterMs: number;
  private readonly backgroundLimit: number;
  private readonly onSlow: ((operation: string, elapsedMs: number) => void) | undefined;
  private readonly now: () => number;
  private readonly running = new Set<{ name: string; startedAt: number }>();

  constructor(options: LifecycleQueueOptions = {}) {
    this.slowAfterMs = options.slowAfterMs ?? 30_000;
    this.backgroundLimit = Math.max(1, options.backgroundLimit ?? DEFAULT_BACKGROUND_LIMIT);
    this.onSlow = options.onSlow;
    this.now = options.now ?? Date.now;
  }

  /** The operation that has held the queue longest right now, for diagnostics. */
  get currentOperation(): string | undefined {
    return [...this.running].sort((left, right) => left.startedAt - right.startedAt)[0]?.name;
  }

  /** True while the caller runs inside a queued operation. */
  get reentrant(): boolean {
    return this.inside.getStore()?.active === true;
  }

  run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.enter(name, operation, false);
  }

  /**
   * Work that builds a thread of its own and touches nothing the thread on
   * screen depends on. Bounded so a burst of them cannot starve the host of
   * file handles, runtimes or CPU.
   */
  runBackground<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.enter(name, operation, true);
  }

  private async enter<T>(name: string, operation: () => Promise<T>, background: boolean): Promise<T> {
    if (this.reentrant) return operation();
    await new Promise<void>((admit) => {
      this.waiting.push({ background, admit });
      this.admitWaiting();
    });
    const entry = { name, startedAt: this.now() };
    this.running.add(entry);
    const token = { name, active: true };
    const timer = setTimeout(() => this.onSlow?.(name, this.now() - entry.startedAt), this.slowAfterMs);
    timer.unref?.();
    try {
      return await this.inside.run(token, operation);
    } finally {
      token.active = false;
      clearTimeout(timer);
      this.running.delete(entry);
      // The queue must survive a failed operation, or one error wedges the host.
      if (background) this.backgroundRunning -= 1;
      else this.exclusiveRunning = false;
      this.admitWaiting();
    }
  }

  /** Lets through as much of the head of the queue as the running work allows. */
  private admitWaiting(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0]!;
      if (this.exclusiveRunning) return;
      if (next.background) {
        if (this.backgroundRunning >= this.backgroundLimit) return;
        this.backgroundRunning += 1;
      } else {
        if (this.backgroundRunning > 0) return;
        this.exclusiveRunning = true;
      }
      this.waiting.shift();
      next.admit();
    }
  }
}
