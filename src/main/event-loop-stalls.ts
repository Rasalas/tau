import { performance } from "node:perf_hooks";

export interface EventLoopStall {
  /** Wall clock for correlating with the host log. */
  observedAt: number;
  /** Monotonic scheduling delay beyond the expected sample interval. */
  delayMs: number;
  sampleWindowMs: number;
  /** Activity during the window, not an attribution of what caused the delay. */
  utilization: number;
  recentEvents: Array<{ label: string; timestamp: number }>;
}

interface Utilization { active: number; idle: number }
export interface EventLoopStallOptions {
  intervalMs?: number;
  thresholdMs?: number;
  limit?: number;
  maxAgeMs?: number;
  now?(): number;
  wallNow?(): number;
  utilization?(): Utilization;
  recentEvents?(): readonly { label: string; timestamp: number }[];
  onStall?(stall: EventLoopStall): void;
}

/** A bounded history of delayed host callbacks. This does not identify a culprit. */
export class EventLoopStallHistory {
  private readonly entries: EventLoopStall[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private generation = 0;
  private previousAt = 0;
  private previousUtilization: Utilization = { active: 0, idle: 0 };

  constructor(private readonly options: EventLoopStallOptions = {}) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.previousAt = this.now();
    this.previousUtilization = this.utilization();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  getHistory(): EventLoopStall[] {
    this.prune((this.options.wallNow ?? Date.now)());
    return this.entries.map((entry) => ({ ...entry, recentEvents: entry.recentEvents.map((event) => ({ ...event })) }));
  }

  private schedule(): void {
    if (!this.running) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (!this.running || this.generation !== generation) return;
      this.timer = undefined;
      const now = this.now();
      const current = this.utilization();
      const sampleWindowMs = Math.max(0, now - this.previousAt);
      const delayMs = Math.max(0, sampleWindowMs - (this.options.intervalMs ?? 100));
      const active = Math.max(0, current.active - this.previousUtilization.active);
      const idle = Math.max(0, current.idle - this.previousUtilization.idle);
      this.previousAt = now;
      this.previousUtilization = current;
      const observedAt = (this.options.wallNow ?? Date.now)();
      this.prune(observedAt);
      if (delayMs >= (this.options.thresholdMs ?? 100)) {
        const stall: EventLoopStall = {
          observedAt, delayMs: Math.round(delayMs * 10) / 10,
          sampleWindowMs: Math.round(sampleWindowMs * 10) / 10,
          utilization: active + idle > 0 ? active / (active + idle) : 0,
          recentEvents: (this.options.recentEvents?.() ?? []).slice(-10).map((event) => ({ label: event.label.slice(0, 120), timestamp: event.timestamp })),
        };
        this.entries.push(stall);
        const requestedLimit = this.options.limit;
        const limit = requestedLimit !== undefined && Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(100, requestedLimit) : 100;
        if (this.entries.length > limit) this.entries.splice(0, this.entries.length - limit);
        // Diagnostic callbacks cannot break monitoring or the host event loop.
        try { this.options.onStall?.({ ...stall, recentEvents: stall.recentEvents.map((event) => ({ ...event })) }); } catch { /* best effort */ }
      }
      // Reschedule from the observed time, avoiding a backlog after one long stall.
      if (this.generation === generation) this.schedule();
    }, this.options.intervalMs ?? 100);
    this.timer.unref?.();
  }

  private prune(wallNow: number): void {
    const before = wallNow - Math.min(15 * 60_000, Math.max(0, this.options.maxAgeMs ?? 15 * 60_000));
    while (this.entries[0] && this.entries[0].observedAt < before) this.entries.shift();
  }
  private now(): number { return (this.options.now ?? (() => performance.now()))(); }
  private utilization(): Utilization { return (this.options.utilization ?? (() => performance.eventLoopUtilization()))(); }
}
