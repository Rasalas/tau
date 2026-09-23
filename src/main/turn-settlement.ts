import { detectProviderLimit, type ProviderLimit } from "./provider-limits.js";
import type { QueuedMessages } from "./queued-messages.js";
import type { ThreadLimits } from "./thread-limits.js";

export interface TurnSettlementPort {
  setTurnError(sessionId: string, error: string | undefined): void;
  setInterrupted(sessionId: string, interrupted: boolean): void;
  queue: Pick<QueuedMessages, "hold" | "started" | "settled">;
  limits: Pick<ThreadLimits, "limited" | "clear">;
  now?(): number;
}

/**
 * What a turn's start and end mean for the marks a thread carries and for its
 * queue. A failure that is a provider limit becomes a limit mark instead of a
 * turn error, and holds the queue: the next message would only hit it again.
 */
export class TurnSettlement {
  constructor(private readonly port: TurnSettlementPort) {}

  /** `reported` is a limit the runtime named itself; a Pi failure is read from its text. */
  settled(sessionId: string, error: string | undefined, reported?: ProviderLimit): void {
    const limit = error === undefined ? undefined : reported ?? detectProviderLimit(error, this.port.now?.() ?? Date.now());
    if (limit && error !== undefined) {
      this.port.setTurnError(sessionId, undefined);
      this.port.limits.limited(sessionId, error, limit.resetsAt);
      this.port.queue.hold(sessionId);
    } else {
      this.port.setTurnError(sessionId, error);
    }
    this.port.queue.settled(sessionId);
  }

  /** A prompt starts a turn: whatever stopped the thread before is over. */
  started(sessionId: string): void {
    this.port.setInterrupted(sessionId, false);
    this.port.setTurnError(sessionId, undefined);
    this.port.limits.clear(sessionId);
    this.port.queue.started(sessionId);
  }
}
