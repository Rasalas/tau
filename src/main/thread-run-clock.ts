import type { HostEvent } from "../shared/contracts.js";

/**
 * When each running thread's run began, as the host saw it. Every client
 * times a run from here, so a phone that connects mid-run shows the same
 * "Working m:ss" as the window that watched it start. An automatic retry
 * reports the run as started again; it keeps the first start.
 */
export class ThreadRunClock {
  private readonly started = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Follows `agent-status` and stamps each `running: true` with the run's start. */
  stamp(event: HostEvent): HostEvent {
    if (event.type !== "agent-status" || !event.sessionId) return event;
    if (!event.running) {
      this.started.delete(event.sessionId);
      return event;
    }
    let startedAt = this.started.get(event.sessionId);
    if (startedAt === undefined) {
      startedAt = event.startedAt ?? this.now();
      this.started.set(event.sessionId, startedAt);
    }
    return event.startedAt === startedAt ? event : { ...event, startedAt };
  }

  /** The running threads and their starts, for a bootstrap. */
  runs(): Record<string, number> {
    return Object.fromEntries(this.started);
  }
}
