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
const failedText = (names: readonly string[]) => `${names.length === 1 ? "a check" : `${names.length} checks`} failed (${names.join(", ")})`;
/** Where a watched PR stands at its last read, for the line about the thread's other watches. */
export function watchStanding(snapshot: WatchSnapshot | undefined): string {
  if (!snapshot) return "not read yet";
  const failed = (snapshot.failed ?? []).map((check) => check.name);
  const checks = snapshot.checks === "none" ? "no checks" : snapshot.checks === "pending" ? ["checks running", ...(failed.length ? [failedText(failed)] : [])].join(", ") : failed.length ? `checks finished, ${failedText(failed)}` : "checks passed";
  return snapshot.conflict ? `${checks}, branch conflicts` : checks;
}
export function watchChanges(before: WatchSnapshot, after: WatchSnapshot): string[] {
  if (after.state !== "OPEN") return [after.state === "MERGED" ? "merged" : "closed"];
  const fresh = before.head !== after.head, current = after.failed ?? [];
  const seen = fresh ? [] : before.failed ?? current;
  const failed = current.filter((check) => !seen.some((old) => old.id === check.id)).map((check) => check.name);
  const finished = after.checks === "done" && (fresh || before.checks !== "done");
  return [
    // The final wake names the outcome, so nobody has to open the PR to learn whether it passed.
    ...(finished ? [current.length ? `checks finished, ${failedText(current.map((check) => check.name))}` : "checks passed"] : failed.length ? [failedText(failed)] : []),
    ...(before.comments !== after.comments ? ["new comments or reviews"] : []),
    ...(!before.conflict && after.conflict ? ["branch conflicts"] : []),
  ];
}
