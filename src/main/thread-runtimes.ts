/**
 * Registry of live thread runtimes.
 *
 * Tau historically held exactly one runtime and swapped it on every thread
 * switch, which is why only one thread could ever be working. This holds many,
 * keyed by Tau thread id, and serialises work per thread instead of globally.
 *
 * It is generic over the runtime so the same registry can hold an in-process
 * `AgentSessionRuntime` or a handle to one living in its own process — the
 * isolation seam Tau needs for untrusted project extensions.
 */

export type ThreadIsolation = "in-process" | "isolated";

export interface ThreadRuntimeRecord<TRuntime> {
  /** Stable Tau product id. Provider/session ids are not registry keys. */
  threadId: string;
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
  private activeThreadId?: string;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(options: ThreadRuntimeRegistryOptions<TRuntime>) {
    this.maxLive = Math.max(1, options.maxLive ?? 3);
    this.disposeRuntime = options.dispose;
    this.canEvict = options.canEvict ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  /** Takes ownership of a runtime. Replacing a thread disposes the old one. */
  async adopt(record: ThreadRuntimeRecord<TRuntime>): Promise<void> {
    const existing = this.slots.get(record.threadId);
    if (existing && existing.runtime !== record.runtime) {
      this.slots.delete(record.threadId);
      await this.disposeRuntime(existing);
    }
    this.slots.set(record.threadId, {
      ...record,
      queue: existing?.queue ?? Promise.resolve(),
      busy: existing?.busy ?? 0,
      lastUsedAt: this.now(),
    });
    await this.evictIdle(record.threadId);
  }

  get(threadId: string): ThreadRuntimeRecord<TRuntime> | undefined {
    const slot = this.slots.get(threadId);
    return slot ? this.recordOf(slot) : undefined;
  }

  private recordOf(slot: ThreadSlot<TRuntime>): ThreadRuntimeRecord<TRuntime> {
    return { threadId: slot.threadId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation };
  }

  has(threadId: string): boolean {
    return this.slots.has(threadId);
  }

  list(): ThreadRuntimeRecord<TRuntime>[] {
    return [...this.slots.values()].map((slot) => ({
      threadId: slot.threadId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation,
    }));
  }

  /** The thread the workbench is showing. It is never evicted. */
  setActive(threadId: string | undefined): void {
    this.activeThreadId = threadId;
    const slot = threadId ? this.slots.get(threadId) : undefined;
    if (slot) slot.lastUsedAt = this.now();
  }

  get active(): ThreadRuntimeRecord<TRuntime> | undefined {
    return this.activeThreadId ? this.get(this.activeThreadId) : undefined;
  }

  /** True while any thread is running work — used to decide idleness. */
  get busyCount(): number {
    return [...this.slots.values()].reduce((total, slot) => total + slot.busy, 0);
  }

  isBusy(threadId: string): boolean {
    return (this.slots.get(threadId)?.busy ?? 0) > 0;
  }

  /**
   * Runs an operation against one thread. Operations on the same thread are
   * serialised; operations on different threads run concurrently.
   */
  run<T>(threadId: string, operation: (record: ThreadRuntimeRecord<TRuntime>) => Promise<T>): Promise<T> {
    const slot = this.slots.get(threadId);
    if (!slot) return Promise.reject(new Error(`No runtime for thread ${threadId}`));
    slot.busy += 1;
    slot.lastUsedAt = this.now();
    // Release the busy count before the caller's await settles, so a thread is
    // reported idle the moment its work is done.
    const task = async () => {
      try {
        return await operation({
          threadId: slot.threadId, cwd: slot.cwd, runtime: slot.runtime, isolation: slot.isolation,
        });
      } finally {
        slot.busy = Math.max(0, slot.busy - 1);
        slot.lastUsedAt = this.now();
      }
    };
    const result = slot.queue.then(task, task);
    // The queue must survive a failed operation, or one error wedges the thread.
    slot.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Counts as use: a turn that just ended keeps its runtime as long as one just opened. */
  touch(threadId: string): void {
    const slot = this.slots.get(threadId);
    if (slot) slot.lastUsedAt = this.now();
  }

  /** Threads whose runtime `releaseIdle` would release now. */
  idleThreadIds(idleMs: number): string[] {
    const cutoff = this.now() - idleMs;
    return [...this.slots.values()]
      .filter((slot) => slot.busy === 0
        && slot.threadId !== this.activeThreadId
        && slot.lastUsedAt <= cutoff
        && this.canEvict(this.recordOf(slot)))
      .map((slot) => slot.threadId);
  }

  /**
   * Releases runtimes nobody used for `idleMs`, under the same guards as
   * eviction. Reopening such a thread is a cold open from its session file.
   */
  async releaseIdle(idleMs: number): Promise<string[]> {
    const released = this.idleThreadIds(idleMs);
    for (const threadId of released) {
      const slot = this.slots.get(threadId);
      if (!slot) continue;
      this.slots.delete(threadId);
      await this.disposeRuntime(slot).catch(() => undefined);
    }
    return released;
  }

  /**
   * Looks every `checkMs` for runtimes idle longer than `idleMs` and releases
   * them through `serialize`, so a release never races an activation.
   */
  startIdleRelease(options: {
    idleMs: number;
    checkMs?: number;
    serialize(operation: () => Promise<string[]>): Promise<string[]>;
    onReleased?(threadIds: string[]): void;
    onError?(error: unknown): void;
  }): void {
    this.stopIdleRelease();
    this.idleTimer = setInterval(() => {
      if (this.idleThreadIds(options.idleMs).length === 0) return;
      void options.serialize(() => this.releaseIdle(options.idleMs))
        .then((released) => { if (released.length > 0) options.onReleased?.(released); })
        .catch((error: unknown) => options.onError?.(error));
    }, options.checkMs ?? Math.min(60_000, options.idleMs));
    this.idleTimer.unref?.();
  }

  stopIdleRelease(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }

  async release(threadId: string): Promise<void> {
    const slot = this.slots.get(threadId);
    if (!slot) return;
    this.slots.delete(threadId);
    if (this.activeThreadId === threadId) this.activeThreadId = undefined;
    await this.disposeRuntime(slot);
  }

  async releaseAll(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.activeThreadId = undefined;
    await Promise.all(slots.map((slot) => this.disposeRuntime(slot).catch(() => undefined)));
  }

  /**
   * Runtimes are not free — a Pi runtime costs on the order of a hundred
   * megabytes — so idle ones beyond the budget are released, oldest first.
   * Busy threads and the one on screen are always kept.
   */
  private async evictIdle(keepThreadId?: string): Promise<void> {
    if (this.slots.size <= this.maxLive) return;
    const candidates = [...this.slots.values()]
      .filter((slot) => slot.busy === 0
        && slot.threadId !== this.activeThreadId
        && slot.threadId !== keepThreadId
        && this.canEvict(this.recordOf(slot)))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    let overflow = this.slots.size - this.maxLive;
    for (const slot of candidates) {
      if (overflow <= 0) break;
      this.slots.delete(slot.threadId);
      overflow -= 1;
      await this.disposeRuntime(slot).catch(() => undefined);
    }
  }
}
