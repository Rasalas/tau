/** A deadline owned by one connection, measured only while that client is awake. */
export interface ConnectionTimer {
  at: number;
  startedAt: number;
  run(): void;
  handle?: unknown;
}

interface TimerOptions {
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** A process resumed without a lifecycle event, such as a headless host. */
  onGap?(): void;
}

const CLOCK_TICK_MS = 1_000;
const CLOCK_GAP_MS = 2_000;

/**
 * One clock for all of a connection's deadlines. Explicit sleep preserves the
 * remaining time. A stalled event loop gets the same treatment before any
 * overdue callback can reject a request or declare a socket dead.
 */
export class ConnectionTimers {
  private readonly pending = new Set<ConnectionTimer>();
  private pulse?: unknown;
  private observed: number;
  private pausedAt?: number;
  private closed = false;
  private checking = false;

  constructor(private readonly options: TimerOptions = {}) { this.observed = this.now(); }

  get paused(): boolean { return this.pausedAt !== undefined; }

  after(ms: number, run: () => void): ConnectionTimer {
    // Rebase existing deadlines before adding one created after a clock jump.
    // Notify after the caller finishes installing the new timer, so a wake
    // cannot re-enter and overwrite its in-progress probe or request.
    if (this.checkClock(false)) queueMicrotask(() => {
      if (!this.closed && !this.paused) this.options.onGap?.();
    });
    const startedAt = this.pausedAt ?? this.now();
    const timer: ConnectionTimer = { at: startedAt + ms, startedAt, run };
    if (this.closed) return timer;
    this.pending.add(timer);
    if (!this.paused) this.arm(timer);
    this.watchClock();
    return timer;
  }

  cancel(timer: ConnectionTimer | undefined): void {
    if (!timer) return;
    this.clear(timer.handle);
    this.pending.delete(timer);
    if (this.pending.size === 0) { this.clear(this.pulse); this.pulse = undefined; }
  }

  pause(): void {
    if (this.closed || this.paused) return;
    this.checkClock(false);
    this.pausedAt = this.now();
    this.clear(this.pulse);
    this.pulse = undefined;
    for (const timer of this.pending) { this.clear(timer.handle); timer.handle = undefined; }
  }

  resume(): void {
    if (this.closed) return;
    if (this.pausedAt !== undefined) {
      const elapsed = this.now() - this.pausedAt;
      this.pausedAt = undefined;
      for (const timer of this.pending) { timer.at += elapsed; timer.startedAt += elapsed; this.arm(timer); }
    } else this.checkClock(false);
    this.observed = this.now();
    this.watchClock();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.pending) this.clear(timer.handle);
    this.pending.clear();
    this.clear(this.pulse);
    this.pulse = undefined;
  }

  observe(): void { this.checkClock(); }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private set(run: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(run, ms);
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  }
  private clear(handle: unknown): void {
    if (handle === undefined) return;
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
  private arm(timer: ConnectionTimer): void {
    this.clear(timer.handle);
    timer.handle = this.set(() => {
      this.checkClock();
      if (this.closed || this.paused || !this.pending.has(timer)) return;
      if (timer.at > this.now()) { this.arm(timer); return; }
      this.cancel(timer);
      timer.run();
    }, Math.max(0, timer.at - this.now()));
  }
  private watchClock(): void {
    if (this.closed || this.paused || this.pulse !== undefined || this.pending.size === 0) return;
    this.observed = this.now();
    this.pulse = this.set(() => {
      this.pulse = undefined;
      this.checkClock();
      this.watchClock();
    }, CLOCK_TICK_MS);
  }
  private checkClock(notify = true): boolean {
    if (this.closed || this.paused || this.checking) return false;
    const now = this.now();
    const elapsed = now - this.observed;
    if (this.pending.size === 0) { this.observed = now; return false; }
    if (elapsed <= CLOCK_GAP_MS && elapsed >= 0) return false;
    this.checking = true;
    this.observed = now;
    // Conservatively exclude the unobserved interval. At most one normal tick
    // is forgiven; sleep, clock changes and a blocked event loop cannot expire a deadline.
    for (const timer of this.pending) {
      const shift = elapsed < 0 ? elapsed : Math.min(elapsed, now - timer.startedAt);
      timer.at += shift;
      timer.startedAt += shift;
      this.arm(timer);
    }
    try { if (notify && elapsed > CLOCK_GAP_MS) this.options.onGap?.(); }
    finally { this.checking = false; }
    return elapsed > CLOCK_GAP_MS;
  }
}
