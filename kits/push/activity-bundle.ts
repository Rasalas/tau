import type { ActivityRow, ActivityUpdate } from "./mobile-activity.js";

/** The thread id of a host's one Live Activity on a phone (K163); the app uses the same. */
export const ACTIVITY_BUNDLE = "tau.threads";
const SHOWN = 4;
/** A finished thread stays in the activity this long, as on the phone. */
const ENDED_SHOWN_MS = 15 * 60_000;
/** Sealed activity content must stay well under the relay's 2304 bytes. */
const MAX_BYTES = 1_700;

/**
 * What this host's Live Activity lists: its top-level threads at work, a
 * question first, and those that ended a moment ago. The activity runs while
 * one of them works and ends once all have finished.
 */
export class ActivityBundle {
  private rows = new Map<string, ActivityRow>();

  constructor(private readonly now: () => number) {}

  note(threadId: string, state: ActivityRow["state"], title: string, reason?: string): void {
    const at = this.now();
    const prior = this.rows.get(threadId);
    const ran = prior?.state === "running" || prior?.state === "waiting";
    const row: ActivityRow = { id: threadId, title: title.slice(0, 60), state };
    const startedAt = state === "running" && !ran ? at : prior?.startedAt;
    if (startedAt !== undefined) row.startedAt = startedAt;
    if (state === "waiting") { row.askedAt = prior?.state === "waiting" && prior.askedAt !== undefined ? prior.askedAt : at; }
    if (state === "done" || state === "failed") row.endedAt = at;
    if (reason && (state === "waiting" || state === "failed")) row.reason = reason.slice(0, 80);
    this.rows.set(threadId, row);
  }

  get active(): boolean { return [...this.rows.values()].some((row) => row.state === "running" || row.state === "waiting"); }

  /** After the activity ended: the next run starts a new one. */
  reset(): void { this.rows.clear(); }

  content(): Pick<ActivityUpdate, "title" | "state" | "threads"> {
    const at = this.now();
    const rank = { waiting: 0, running: 1, done: 2, failed: 2 } as const;
    const rows = [...this.rows.values()]
      .filter((row) => row.state === "running" || row.state === "waiting" || at - (row.endedAt ?? 0) < ENDED_SHOWN_MS)
      .sort((left, right) => rank[left.state] - rank[right.state]
        || (left.endedAt === undefined ? (left.startedAt ?? 0) - (right.startedAt ?? 0) : (right.endedAt ?? 0) - left.endedAt))
      .slice(0, SHOWN);
    const waiting = rows.filter((row) => row.state === "waiting").length;
    const running = rows.filter((row) => row.state === "running").length;
    const state: ActivityUpdate["state"] = waiting > 0 ? "needs-input" : running > 0 ? "running" : "completed";
    const title = waiting > 0 ? `${waiting} waiting · ${running} running` : running > 0 ? `${running} running` : "Done";
    // Reasons go first, then the oldest rows, until the sealed content fits.
    const threads = rows.map((row) => ({ ...row }));
    while (Buffer.byteLength(JSON.stringify(threads)) > MAX_BYTES) {
      const long = threads.find((row) => row.reason);
      if (long) delete long.reason; else threads.pop();
    }
    return { title, state, threads };
  }
}
