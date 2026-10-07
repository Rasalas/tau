import type { PullRequestRef } from "./protocol.js";
export interface WatchSnapshot { state: "OPEN" | "CLOSED" | "MERGED"; head: string; checks: string; comments: string; conflict: boolean }
export interface PullRequestWatch {
  threadId: string; ref: PullRequestRef; status: "watching" | "unreadable" | "ended";
  startedAt: number; lastReadAt?: number; wakes: number; commentStreak: number;
  baseline?: WatchSnapshot; reason?: string; stoppedBy?: "user" | "settle";
}
export interface WatchState { watches: PullRequestWatch[]; canManage?: boolean }
export function watchChanges(before: WatchSnapshot, after: WatchSnapshot): string[] {
  if (after.state !== "OPEN") return [after.state === "MERGED" ? "merged" : "closed"];
  return [
    ...((before.checks !== after.checks || before.head !== after.head) && after.checks !== "PENDING" && after.checks !== "NONE" ? ["checks finished"] : []),
    ...(before.comments !== after.comments ? ["new comments or reviews"] : []),
    ...(!before.conflict && after.conflict ? ["branch conflicts"] : []),
  ];
}
