import type { UiThreadLimit } from "../shared/contracts.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const VERSION = 1;

/** What the host sends a thread a limit stopped, when it picks it back up. */
export const LIMIT_CONTINUATION_PROMPT =
  "Continue the interrupted work; the previous attempt stopped at a provider usage limit.";

/** A reset is rarely exact to the second; the continuation waits this much longer. */
export const RESUME_MARGIN_MS = 60_000;

/** setTimeout's ceiling; a later resume re-arms when this one fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The longest a user-chosen retry may wait: a week, past any provider's weekly window. */
export const MAX_RETRY_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface ThreadLimitsPort {
  publish(sessionId: string, limit: UiThreadLimit | undefined): void;
  /**
   * Continues the thread the limit stopped: with the messages the user wrote
   * while it waited, or with the continuation prompt. `limitedAt` is when the
   * limit stopped it, so messages queued before it stay follow-ups.
   */
  resume(sessionId: string, limitedAt: number | undefined): Promise<void>;
  log(label: string, detail?: string): void;
  now?(): number;
}

export interface ThreadLimitsOptions {
  /** `<userData>/thread-limits.json`; without one a scheduled resume only lasts for this run. */
  filePath?: string;
  logger?: PersistedJsonLogger;
}

function decodeLimits(value: unknown): Map<string, UiThreadLimit> {
  const limits = new Map<string, UiThreadLimit>();
  const threads = (value as { threads?: unknown } | undefined)?.threads;
  if (!threads || typeof threads !== "object" || Array.isArray(threads)) return limits;
  for (const [sessionId, entry] of Object.entries(threads as Record<string, unknown>)) {
    const item = entry as Partial<UiThreadLimit> | undefined;
    if (!item || typeof item.message !== "string") continue;
    limits.set(sessionId, {
      message: item.message,
      ...(typeof item.resetsAt === "number" ? { resetsAt: item.resetsAt } : {}),
      ...(typeof item.resumeAt === "number" ? { resumeAt: item.resumeAt } : {}),
      ...(typeof item.limitedAt === "number" ? { limitedAt: item.limitedAt } : {}),
    });
  }
  return limits;
}

/**
 * Threads a provider stopped at a usage or rate limit. The mark lasts until
 * the thread runs again; the user either continues it now or lets the host
 * continue it when the limit resets. Only a scheduled resume is written down,
 * so it survives a restart; a mark without one is this run's.
 */
export class ThreadLimits {
  private readonly limits = new Map<string, UiThreadLimit>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Threads whose resume is under way: their queue may send now. */
  private readonly resuming = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private loading?: Promise<void>;
  private frozen = false;

  constructor(private readonly port: ThreadLimitsPort, private readonly options: ThreadLimitsOptions = {}) {}

  private now(): number {
    return this.port.now?.() ?? Date.now();
  }

  get(sessionId: string): UiThreadLimit | undefined {
    return this.limits.get(sessionId);
  }

  /** The thread waits for a scheduled resume: what is queued for it waits too, and leaves with the resume. */
  awaitsResume(sessionId: string): boolean {
    return this.limits.get(sessionId)?.resumeAt !== undefined && !this.resuming.has(sessionId);
  }

  /** Reads the resumes the previous run scheduled and arms them again; one that is due runs now. */
  async restore(): Promise<void> {
    await this.load();
    for (const [sessionId, limit] of this.limits) {
      if (limit.resumeAt !== undefined) this.arm(sessionId, limit.resumeAt);
    }
  }

  /** Loads saved limits before recovery; timers wait until restore. */
  load(): Promise<void> {
    return this.loading ??= this.read();
  }

  private async read(): Promise<void> {
    if (!this.options.filePath) return;
    const read = await readPersistedJson(this.options.filePath, {
      expectedVersion: VERSION,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      decode: (value) => decodeLimits(value),
    });
    for (const [sessionId, limit] of read?.data ?? []) {
      if (this.limits.has(sessionId)) continue;
      this.limits.set(sessionId, limit);
      this.port.publish(sessionId, limit);
    }
  }

  /** A turn stopped at a limit. */
  limited(sessionId: string, message: string, resetsAt?: number): void {
    this.disarm(sessionId);
    const limit: UiThreadLimit = { message, ...(resetsAt !== undefined ? { resetsAt } : {}), limitedAt: this.now() };
    this.limits.set(sessionId, limit);
    this.port.publish(sessionId, limit);
    this.persist();
    this.port.log("limit.reached", `${sessionId.slice(0, 8)}${resetsAt ? ` · resets ${new Date(resetsAt).toISOString()}` : ""}`);
  }

  /** The thread runs again, whoever started it. */
  clear(sessionId: string): void {
    this.disarm(sessionId);
    if (!this.limits.delete(sessionId)) return;
    this.port.publish(sessionId, undefined);
    this.persist();
  }

  /** Continues the thread when its limit resets; refused when the provider named no reset. */
  resumeAtReset(sessionId: string): UiThreadLimit {
    const limit = this.limits.get(sessionId);
    if (!limit) throw new Error("This thread is not waiting for a limit.");
    if (limit.resetsAt === undefined) throw new Error("The provider did not say when its limit resets; choose when to retry.");
    return this.schedule(sessionId, limit, Math.max(limit.resetsAt, this.now()) + RESUME_MARGIN_MS);
  }

  /** Continues the thread at a time the user chose, for a limit whose reset nobody named (or one they would rather retry sooner). */
  resumeAt(sessionId: string, at: number): UiThreadLimit {
    const limit = this.limits.get(sessionId);
    if (!limit) throw new Error("This thread is not waiting for a limit.");
    if (!Number.isFinite(at) || at <= this.now()) throw new Error("Choose a time in the future.");
    if (at - this.now() > MAX_RETRY_WAIT_MS) throw new Error("Choose a time within the next seven days.");
    return this.schedule(sessionId, limit, at);
  }

  private schedule(sessionId: string, limit: UiThreadLimit, resumeAt: number): UiThreadLimit {
    const next = { ...limit, resumeAt };
    this.limits.set(sessionId, next);
    this.arm(sessionId, next.resumeAt);
    this.port.publish(sessionId, next);
    this.persist();
    this.port.log("limit.resume-scheduled", `${sessionId.slice(0, 8)} · ${new Date(next.resumeAt).toISOString()}`);
    return next;
  }

  /** Keeps the mark and drops the scheduled resume. */
  cancelResume(sessionId: string): void {
    const limit = this.limits.get(sessionId);
    this.disarm(sessionId);
    if (!limit || limit.resumeAt === undefined) return;
    const { resumeAt: _dropped, ...rest } = limit;
    this.limits.set(sessionId, rest);
    this.port.publish(sessionId, rest);
    this.persist();
  }

  /** Continues the thread now; the continuation's prompt clears the mark. */
  async resumeNow(sessionId: string): Promise<void> {
    if (!this.limits.has(sessionId)) throw new Error("This thread is not waiting for a limit.");
    this.disarm(sessionId);
    await this.continue(sessionId);
  }

  /** While it runs, the thread's queue is free to send: the resume may be the user's queued message. */
  private async continue(sessionId: string): Promise<void> {
    this.resuming.add(sessionId);
    try {
      await this.port.resume(sessionId, this.limits.get(sessionId)?.limitedAt);
    } finally {
      this.resuming.delete(sessionId);
    }
  }

  forget(sessionId: string): void {
    this.clear(sessionId);
  }

  /** The host is stopping: no timer fires into its teardown, and the file keeps what was scheduled. */
  freeze(): void {
    this.frozen = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private arm(sessionId: string, at: number): void {
    this.disarm(sessionId);
    if (this.frozen) return;
    const delay = Math.max(0, at - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.limits.get(sessionId)?.resumeAt !== at) return;
      if (at > this.now()) { this.arm(sessionId, at); return; }
      this.port.log("limit.resuming", sessionId.slice(0, 8));
      this.continue(sessionId).catch((error: unknown) => {
        this.port.log("limit.resume-failed", `${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        this.cancelResume(sessionId);
      });
    }, Math.min(delay, MAX_TIMER_MS));
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private disarm(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private persist(): void {
    const path = this.options.filePath;
    if (!path || this.frozen) return;
    const threads = Object.fromEntries([...this.limits].filter(([, limit]) => limit.resumeAt !== undefined));
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => writePersistedJson(path, VERSION, { threads }, this.options.logger ? { logger: this.options.logger } : {}))
      .catch(() => undefined);
  }
}
