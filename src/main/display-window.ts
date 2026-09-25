/** A window on the invisible display that nobody called for this long is stopped (the user's choice, plan H). */
export const DISPLAY_WINDOW_IDLE_MS = 10 * 60_000;
/** How long a call waits for the window it started to say hello. */
export const DISPLAY_WINDOW_ATTACH_TIMEOUT_MS = 60_000;

export interface DisplayWindowControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DisplayWindowTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): { unref?(): void };
  clearTimeout(timer: unknown): void;
}

const realTimers: DisplayWindowTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * The Tau window on a Linux service host's invisible display, run on demand:
 * `ensure` starts it when a call needs a window half and none is attached,
 * `activity` marks a call it answered, and after `idleMs` without one it is
 * stopped. The next call starts it again.
 */
export class DisplayWindow {
  private starting: Promise<void> | undefined;
  private lastActivity = 0;
  private timer: unknown;
  private readonly timers: DisplayWindowTimers;
  private readonly idleMs: number;
  private readonly log: (event: string, detail?: unknown) => void;

  constructor(
    private readonly control: DisplayWindowControl,
    options: { idleMs?: number; timers?: DisplayWindowTimers; log?: (event: string, detail?: unknown) => void } = {},
  ) {
    this.idleMs = options.idleMs ?? DISPLAY_WINDOW_IDLE_MS;
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? (() => undefined);
  }

  /** Starts the window; concurrent callers share one start. */
  ensure(): Promise<void> {
    this.activity();
    this.starting ??= this.control.start().then(
      () => { this.log("display-window.started"); },
      (error: unknown) => { this.log("display-window.start-failed", error); throw error; },
    ).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** A call went to (or came back from) the window. */
  activity(): void {
    this.lastActivity = this.timers.now();
    if (this.timer === undefined) this.arm(this.idleMs);
  }

  dispose(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number): void {
    const timer = this.timers.setTimeout(() => this.check(), ms);
    timer.unref?.();
    this.timer = timer;
  }

  private check(): void {
    this.timer = undefined;
    const idle = this.timers.now() - this.lastActivity;
    if (idle < this.idleMs) {
      this.arm(this.idleMs - idle);
      return;
    }
    this.log("display-window.idle-stop", { idleMs: idle });
    this.control.stop().catch((error: unknown) => this.log("display-window.stop-failed", error));
  }
}
