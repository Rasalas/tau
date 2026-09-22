import type { ThreadResumeCapability } from "./runtime-types.js";
import type { InFlightTurn } from "./turns-in-flight.js";

/** What the host sends a thread whose turn a restart cut short. */
export const RESTART_CONTINUATION_PROMPT =
  "Continue the interrupted work; the previous attempt was cut off by a restart.";

export function restartInterruptionNotice(startedAt: number): string {
  return `Interrupted by a restart at ${new Date(startedAt).toLocaleString()}`;
}

/** The same line, for a thread the host is about to pick back up. */
export function restartContinuationNotice(startedAt: number): string {
  return `${restartInterruptionNotice(startedAt)}. Continuing the interrupted work.`;
}

/** A thread the host reopened for a marker, with only what reconciling needs. */
export interface ReconcilableThread {
  threadId: string;
  /** Closes tool calls the cut-short turn left open; returns how many. */
  repair(): Promise<number>;
  /** How this runtime continues, when it can at all. */
  resume?: ThreadResumeCapability;
  /** Delivers the continuation through the host's own prompt path. */
  prompt(text: string, hidden: boolean): Promise<void>;
}

export interface TurnReconciliationPort {
  markers(): readonly InFlightTurn[];
  /** Drops the marker. Called before continuing, so a second start continues nothing twice. */
  forget(sessionId: string): void;
  /** Settings → Defaults; off unless the user asked for it. */
  continueAfterRestart(): boolean;
  /** Reopens the marked thread off screen; `undefined` when its session is gone. */
  open(marker: InFlightTurn): Promise<ReconcilableThread | undefined>;
  markInterrupted(sessionId: string): void;
  log(label: string, detail?: string): void;
  errorMessage(error: unknown): string;
}

export interface TurnReconciliation {
  continued: string[];
  interrupted: string[];
}

/**
 * What the host does about the turns it never finished. Continuing is opt-in;
 * the default is to leave the thread repaired, say so in the transcript and
 * mark it, so nothing a user did not ask for costs them a model call.
 *
 * A marker is dropped before its thread is touched: a host that dies halfway
 * through this pass continues nothing twice on the next start.
 */
export async function reconcileInFlightTurns(port: TurnReconciliationPort): Promise<TurnReconciliation> {
  const result: TurnReconciliation = { continued: [], interrupted: [] };
  const markers = [...port.markers()];
  if (markers.length === 0) return result;
  const shouldContinue = port.continueAfterRestart();
  port.log("turns.in-flight", `${markers.length} · ${shouldContinue ? "continuing" : "marking interrupted"}`);
  for (const marker of markers) {
    port.forget(marker.sessionId);
    try {
      const thread = await port.open(marker);
      if (!thread) {
        port.log("turns.in-flight.gone", marker.sessionId.slice(0, 8));
        continue;
      }
      const repaired = await thread.repair();
      const resume = thread.resume;
      if (shouldContinue && resume) {
        // The notice comes first either way: a continuation nobody asked for
        // must not read as something the user typed, hidden or not.
        await resume.notice?.(restartContinuationNotice(marker.startedAt));
        await thread.prompt(RESTART_CONTINUATION_PROMPT, resume.hiddenPrompt);
        result.continued.push(marker.sessionId);
        port.log("turns.in-flight.continued", `${marker.sessionId.slice(0, 8)} · ${repaired} repaired`);
        continue;
      }
      await resume?.notice?.(restartInterruptionNotice(marker.startedAt));
      port.markInterrupted(marker.sessionId);
      result.interrupted.push(marker.sessionId);
      port.log("turns.in-flight.interrupted", `${marker.sessionId.slice(0, 8)} · ${repaired} repaired`);
    } catch (error) {
      // One unusable marker must never stop the host from starting.
      port.log("turns.in-flight.failed", `${marker.sessionId.slice(0, 8)}: ${port.errorMessage(error)}`);
    }
  }
  return result;
}
