import type { PullRequestRef } from "./protocol.js";
export interface FailedCheck { id: string; name: string }
export interface WatchSnapshot {
  state: "OPEN" | "CLOSED" | "MERGED"; head: string; checks: "none" | "pending" | "done";
  /** Absent on a baseline saved before failures were tracked; the next read adopts its failures without a wake. */
  failed?: FailedCheck[];
  comments: string; conflict: boolean;
}
export interface PullRequestWatch {
  threadId: string; ref: PullRequestRef; status: "watching" | "unreadable" | "ended";
  startedAt: number; lastReadAt?: number; wakes: number; commentStreak: number;
  baseline?: WatchSnapshot; reason?: string; stoppedBy?: "user" | "settle";
}
export interface WatchState { watches: PullRequestWatch[]; canManage?: boolean }
export function watchChanges(before: WatchSnapshot, after: WatchSnapshot): string[] {
  if (after.state !== "OPEN") return [after.state === "MERGED" ? "merged" : "closed"];
  const fresh = before.head !== after.head, current = after.failed ?? [];
  const seen = fresh ? [] : before.failed ?? current;
  const failed = current.filter((check) => !seen.some((old) => old.id === check.id)).map((check) => check.name);
  return [
    ...(after.checks === "done" && (fresh || before.checks !== "done") ? ["checks finished"] : []),
    ...(failed.length ? [`${failed.length === 1 ? "a check" : `${failed.length} checks`} failed (${failed.join(", ")})`] : []),
    ...(before.comments !== after.comments ? ["new comments or reviews"] : []),
    ...(!before.conflict && after.conflict ? ["branch conflicts"] : []),
  ];
}
