import type { HostEvent } from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol.js";

/** Longest a run's end waits for the turn meant to continue it. */
const HOLD_MS = 10_000;

export interface ThreadRunClockPort {
  /** Something already waits to continue the thread: a turn still open, or a queued message. */
  continues(sessionId: string): boolean;
  /** Sends a held end on, as `stamp` would have. */
  forward(event: HostEvent): void;
  /** The run is over, ended now or long ago. */
  ended(sessionId: string): void;
}

/**
 * When each running thread's run began, as the host saw it. Every client
 * times a run from here, so a phone that connects mid-run shows the same
 * "Working m:ss" as the window that watched it start. An automatic retry
 * reports the run as started again; it keeps the first start.
 *
 * A run spans turns: a turn that ends while the next one waits (a queued
 * message, a follow-up the runtime starts itself) holds its end back, so no
 * client shows the thread done or notifies in between.
 */
export class ThreadRunClock {
  private readonly started = new Map<string, number>();
  private readonly held = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly port?: ThreadRunClockPort,
    private readonly holdMs = HOLD_MS,
  ) {}

  /** Stamps each `running: true` with the run's start; undefined swallows an end held back. */
  stamp(event: HostEvent): HostEvent | undefined {
    if (event.type === "host-update" && event.update.type === "run") {
      const { sessionId } = event.update;
      if (event.update.event === "started") this.unhold(sessionId);
      else if (this.held.has(sessionId)) return undefined;
      else if (this.started.has(sessionId) && this.port?.continues(sessionId)) {
        this.hold(sessionId);
        return undefined;
      }
      return event;
    }
    if (event.type !== "agent-status" || !event.sessionId) return event;
    if (!event.running) {
      if (this.held.has(event.sessionId)) return undefined;
      const wasRunning = this.started.delete(event.sessionId);
      if (wasRunning) queueMicrotask(() => this.port?.ended(event.sessionId));
      return event;
    }
    this.unhold(event.sessionId);
    let startedAt = this.started.get(event.sessionId);
    if (startedAt === undefined) {
      startedAt = event.startedAt ?? this.now();
      this.started.set(event.sessionId, startedAt);
    }
    return event.startedAt === startedAt ? event : { ...event, startedAt };
  }

  /** What could continue the thread changed: a held end goes out once nothing does. */
  recheck(sessionId: string): void {
    if (this.held.has(sessionId)) {
      if (!this.port?.continues(sessionId)) this.release(sessionId);
    } else if (!this.started.has(sessionId)) this.port?.ended(sessionId);
  }

  /** The running threads and their starts, for a bootstrap. */
  runs(): Record<string, number> {
    return Object.fromEntries(this.started);
  }

  private hold(sessionId: string): void {
    const timer = setTimeout(() => this.release(sessionId), this.holdMs);
    timer.unref?.();
    this.held.set(sessionId, timer);
  }

  private unhold(sessionId: string): void {
    const timer = this.held.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.held.delete(sessionId);
  }

  private release(sessionId: string): void {
    if (!this.held.has(sessionId)) return;
    this.unhold(sessionId);
    this.port?.forward({ type: "host-update", update: { version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId } });
    const end = this.stamp({ type: "agent-status", sessionId, running: false });
    if (end) this.port?.forward(end);
  }
}
