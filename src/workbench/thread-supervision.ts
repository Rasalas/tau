import type { UiSession } from "../shared/contracts";
import type { ThreadActivitySnapshot } from "./thread-store";

/**
 * What a thread is doing right now, in the words a supervisor needs: a phone
 * screen shows this and nothing else. `waiting` outranks `running` because a
 * question is the only state that needs the user before anything continues.
 */
export type ThreadSupervisionStatus = "waiting" | "running" | "failed" | "done";

export interface ThreadSupervisionRow {
  id: string;
  title: string;
  projectName: string;
  status: ThreadSupervisionStatus;
  /** Set while the thread is running, for the elapsed timer. */
  startedAt?: number;
  /** A finished run the user has not looked at yet. */
  unread: boolean;
  modifiedAt: number;
}

const RANK: Record<ThreadSupervisionStatus, number> = { waiting: 0, running: 1, failed: 2, done: 3 };

export function threadSupervisionStatus(id: string, activity: ThreadActivitySnapshot): ThreadSupervisionStatus {
  if (activity.waitingThreadIds.includes(id)) return "waiting";
  if (activity.runningThreadIds.includes(id)) return "running";
  if (activity.failedThreadIds.includes(id)) return "failed";
  return "done";
}

/**
 * The threads a supervisor sees first: everything that needs attention, then
 * the rest by recency. `limit` keeps the list a screen tall rather than an
 * index — opening a thread is one tap away either way.
 */
export function threadSupervisionRows(
  threads: readonly UiSession[],
  activity: ThreadActivitySnapshot,
  limit = 12,
): ThreadSupervisionRow[] {
  const rows = threads.map((thread): ThreadSupervisionRow => {
    const status = threadSupervisionStatus(thread.id, activity);
    const startedAt = activity.runningStartedAt[thread.id];
    return {
      id: thread.id,
      title: thread.title || "Untitled thread",
      projectName: thread.projectName,
      status,
      ...(startedAt === undefined ? {} : { startedAt }),
      unread: activity.unreadThreadIds.includes(thread.id),
      modifiedAt: thread.modifiedAt,
    };
  });
  rows.sort((left, right) => RANK[left.status] - RANK[right.status] || right.modifiedAt - left.modifiedAt);
  return rows.slice(0, limit);
}

export const THREAD_SUPERVISION_LABELS: Record<ThreadSupervisionStatus, string> = {
  waiting: "Waiting for an answer",
  running: "Running",
  failed: "Failed",
  done: "Done",
};
