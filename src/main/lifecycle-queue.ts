import { AsyncLocalStorage } from "node:async_hooks";

export interface LifecycleQueueOptions {
  /** How long an operation may hold the queue before it is reported. */
  slowAfterMs?: number;
  /** Reports a long-running operation; the operation is never aborted. */
  onSlow?(operation: string, elapsedMs: number): void;
  now?(): number;
}

/**
 * Serialises the host's thread lifecycle work: opening, switching, forking and
 * disposing threads never interleave.
 *
 * An operation started while the caller is already inside the queue runs
 * inline instead of enqueuing itself. That is what keeps a lifecycle hook - or
 * an extension calling `sessions.exclusive` from one - from waiting for the
 * operation it is itself part of, the deadlock ADR 0004 was written about.
 */
export class LifecycleQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly inside = new AsyncLocalStorage<string>();
  private readonly slowAfterMs: number;
  private readonly onSlow: ((operation: string, elapsedMs: number) => void) | undefined;
  private readonly now: () => number;
  private running?: { name: string; startedAt: number };

  constructor(options: LifecycleQueueOptions = {}) {
    this.slowAfterMs = options.slowAfterMs ?? 30_000;
    this.onSlow = options.onSlow;
    this.now = options.now ?? Date.now;
  }

  /** The operation holding the queue right now, for diagnostics. */
  get currentOperation(): string | undefined {
    return this.running?.name;
  }

  /** True while the caller runs inside a queued operation. */
  get reentrant(): boolean {
    return this.inside.getStore() !== undefined;
  }

  run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (this.inside.getStore() !== undefined) return operation();
    const task = async (): Promise<T> => {
      const startedAt = this.now();
      this.running = { name, startedAt };
      const timer = setTimeout(() => this.onSlow?.(name, this.now() - startedAt), this.slowAfterMs);
      timer.unref?.();
      try {
        return await this.inside.run(name, operation);
      } finally {
        clearTimeout(timer);
        if (this.running?.startedAt === startedAt) this.running = undefined;
      }
    };
    const result = this.tail.then(task, task);
    // The queue must survive a failed operation, or one error wedges the host.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
