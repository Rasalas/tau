/**
 * Registry of live thread runtimes.
 *
 * Tau historically held exactly one runtime and swapped it on every thread
 * switch, which is why only one thread could ever be working. This holds many,
 * keyed by session, and serialises work per thread instead of globally.
 *
 * It is generic over the runtime so the same registry can hold an in-process
 * `AgentSessionRuntime` or a handle to one living in its own process — the
 * isolation seam Tau needs for untrusted project extensions.
 */

export type ThreadIsolation = "in-process" | "isolated";

export interface ThreadRuntimeRecord<TRuntime> {
  sessionId: string;
  cwd: string;
  runtime: TRuntime;
  isolation: ThreadIsolation;
}

interface ThreadSlot<TRuntime> extends ThreadRuntimeRecord<TRuntime> {
  /** Serialises operations for this thread only. */
  queue: Promise<unknown>;
  /** Depth of in-flight work, so an active thread is never evicted. */
  busy: number;
  lastUsedAt: number;
}

export interface ThreadRuntimeRegistryOptions<TRuntime> {
  /** Live runtimes to keep before the least recently used idle one is released. */
  maxLive?: number;
  dispose(record: ThreadRuntimeRecord<TRuntime>): Promise<void>;
  /** Extra guard for eviction: a runtime with its own in-flight work is never released. */
  canEvict?(record: ThreadRuntimeRecord<TRuntime>): boolean;
  now?(): number;
}

export class ThreadRuntimeRegistry<TRuntime> {
  private readonly slots = new Map<string, ThreadSlot<TRuntime>>();
  private readonly maxLive: number;
  private readonly disposeRuntime: (record: ThreadRuntimeRecord<TRuntime>) => Promise<void>;
  private readonly canEvict: (record: ThreadRuntimeRecord<TRuntime>) => boolean;
  private readonly now: () => number;
  private activeSessionId?: string;

  constructor(options: ThreadRuntimeRegistryOptions<TRuntime>) {
    this.maxLive = Math.max(1, options.maxLive ?? 3);
    this.disposeRuntime = options.dispose;
    this.canEvict = options.canEvict ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  /** Takes ownership of a runtime. Replacing a session disposes the old one. */
  async adopt(record: ThreadRuntimeRecord<TRuntime>): Promise<void> {
    const existing = this.slots.get(record.sessionId);
    if (existing && existing.runtime !== record.runtime) {
      this.slots.delete(record.sessionId);
      await this.disposeRuntime(existing);
    }
    this.slots.set(record.sessionId, {
      ...record,
      queue: existing?.queue ?? Promise.resolve(),
      busy: existing?.busy ?? 0,
      lastUsedAt: this.now(),
    });
    await this.evictIdle(record.sessionId);
  }

  get(sessionId: string): ThreadRuntimeRecord<TRuntime> | undefined {
    const slot = this.slots.get(sessionId);
    return slot ? this.recordOf(slot) : undefined;
  }

  private recordOf(slot: ThreadSlot<TRuntime>): ThreadRuntimeRecord<TRuntime> {
    return { sessionId: slot.sessionId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation };
  }

  has(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  list(): ThreadRuntimeRecord<TRuntime>[] {
    return [...this.slots.values()].map((slot) => ({
      sessionId: slot.sessionId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation,
    }));
  }

  /** The thread the workbench is showing. It is never evicted. */
  setActive(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
    const slot = sessionId ? this.slots.get(sessionId) : undefined;
    if (slot) slot.lastUsedAt = this.now();
  }

  get active(): ThreadRuntimeRecord<TRuntime> | undefined {
    return this.activeSessionId ? this.get(this.activeSessionId) : undefined;
  }

  /** True while any thread is running work — used to decide idleness. */
  get busyCount(): number {
    return [...this.slots.values()].reduce((total, slot) => total + slot.busy, 0);
  }

  isBusy(sessionId: string): boolean {
    return (this.slots.get(sessionId)?.busy ?? 0) > 0;
  }

  /**
   * Runs an operation against one thread. Operations on the same thread are
   * serialised; operations on different threads run concurrently.
   */
  run<T>(sessionId: string, operation: (record: ThreadRuntimeRecord<TRuntime>) => Promise<T>): Promise<T> {
    const slot = this.slots.get(sessionId);
    if (!slot) return Promise.reject(new Error(`No runtime for thread ${sessionId}`));
    slot.busy += 1;
    slot.lastUsedAt = this.now();
    // Release the busy count before the caller's await settles, so a thread is
    // reported idle the moment its work is done.
    const task = async () => {
      try {
        return await operation({
          sessionId: slot.sessionId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation,
        });
      } finally {
        slot.busy = Math.max(0, slot.busy - 1);
      }
    };
    const result = slot.queue.then(task, task);
    // The queue must survive a failed operation, or one error wedges the thread.
    slot.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    this.slots.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
    await this.disposeRuntime(slot);
  }

  async releaseAll(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.activeSessionId = undefined;
    await Promise.all(slots.map((slot) => this.disposeRuntime(slot).catch(() => undefined)));
  }

  /**
   * Runtimes are not free — a Pi runtime costs on the order of a hundred
   * megabytes — so idle ones beyond the budget are released, oldest first.
   * Busy threads and the one on screen are always kept.
   */
  private async evictIdle(keepSessionId?: string): Promise<void> {
    if (this.slots.size <= this.maxLive) return;
    const candidates = [...this.slots.values()]
      .filter((slot) => slot.busy === 0
        && slot.sessionId !== this.activeSessionId
        && slot.sessionId !== keepSessionId
        && this.canEvict(this.recordOf(slot)))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    let overflow = this.slots.size - this.maxLive;
    for (const slot of candidates) {
      if (overflow <= 0) break;
      this.slots.delete(slot.sessionId);
      overflow -= 1;
      await this.disposeRuntime(slot).catch(() => undefined);
    }
  }
}
