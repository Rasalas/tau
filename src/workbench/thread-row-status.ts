import type { UiSession } from "../shared/contracts";
import type { ThreadActivitySnapshot } from "./thread-store";

/** `background`: stopped, with work that wakes it again, such as a watched pull request (API 1.56.0). */
export type ThreadActivity = "idle" | "ready" | "working" | "tool" | "settled" | "waiting" | "background" | "stalled" | "interrupted" | "failed" | "limited" | "offline";

/** What a thread row says about its thread, the same on the desktop rail, a tablet's list and a phone's. */
export interface ThreadRowStatus {
  activity: ThreadActivity;
  label: string;
  /** What the state means, for the badge's tooltip. */
  hint?: string;
  /** The host's start of the run, for `Working m:ss`; set while the thread runs. */
  startedAt?: number;
  /** A kit mark's icon, drawn in place of the state's own. */
  icon?: unknown;
}

/**
 * A state a kit gives a thread's row on every client (API 1.56.0): a takeover's
 * "Your turn" asks for the user; `tone: "background"` is work that wakes the
 * thread again, such as a watched pull request.
 */
export interface ThreadRowMark<Icon = unknown> {
  label: string;
  hint?: string;
  icon?: Icon;
  tone?: "background";
}

/** A row's state under a kit's mark: a mark that asks wins; background work only stands in for an idle or ready row. */
export function markedRowStatus(base: ThreadRowStatus, mark: ThreadRowMark | undefined): ThreadRowStatus {
  if (!mark) return base;
  const { tone, ...shown } = mark;
  if (tone !== "background") return { ...shown, activity: "waiting" };
  return base.activity === "idle" || base.activity === "ready" ? { ...shown, activity: "background" } : base;
}

/** The threads whose marks ask for the user; lists order them as questions. */
export function attentionMarkIds(marks: Readonly<Record<string, ThreadRowMark>>): string[] {
  return Object.entries(marks).filter(([, mark]) => mark.tone !== "background").map(([id]) => id);
}

export const THREAD_QUESTION_LABEL = "Question";

export function threadLimitHint(limit: UiSession["limit"], now = Date.now()): string {
  if (!limit) return "A provider limit stopped this thread.";
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (limit.resumeAt !== undefined) return `A usage limit stopped this thread; it continues by itself at ${time(limit.resumeAt)}.`;
  if (limit.resetsAt !== undefined && limit.resetsAt > now) return `A usage limit stopped this thread; it resets at ${time(limit.resetsAt)}.`;
  return "A usage limit stopped this thread. Open it to continue.";
}

/** The one derivation of a row's state from the thread store's activity; every client's list calls it. */
export function threadRowStatus(
  id: string,
  activity: ThreadActivitySnapshot,
  thread?: Pick<UiSession, "limit" | "turnError">,
): ThreadRowStatus {
  // A stalled question outranks every other state: nothing moves until it is answered.
  if (activity.waitingThreadIds.includes(id)) return { activity: "waiting", label: THREAD_QUESTION_LABEL };
  if (activity.runningThreadIds.includes(id)) {
    const startedAt = activity.runningStartedAt[id];
    return { activity: "working", label: "Working", ...(startedAt === undefined ? {} : { startedAt }) };
  }
  // A provider limit stopped the thread; it continues now, at the reset, or with the next message.
  if (activity.limitedThreadIds.includes(id)) return { activity: "limited", label: "Rate limited", hint: threadLimitHint(thread?.limit) };
  if (activity.failedThreadIds.includes(id)) {
    return { activity: "failed", label: "Failed", hint: thread?.turnError ?? "The last message did not reach the agent." };
  }
  if (activity.interruptedThreadIds.includes(id)) {
    return { activity: "interrupted", label: "Interrupted", hint: "A restart cut this thread's turn short. Send a message to pick it back up." };
  }
  // A tool still marked running while nothing is in flight is a dead turn, not work.
  if (id === activity.activeThreadId && activity.runningToolName) return { activity: "stalled", label: "Interrupted" };
  // Ready means "finished while you were elsewhere"; opening the thread clears it.
  if (activity.unreadThreadIds.includes(id)) return { activity: "ready", label: "Ready" };
  return { activity: "idle", label: "Idle" };
}
