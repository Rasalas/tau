import type { PullRequestWatch } from "./pr-watch-protocol.js";

export interface WatchRowStatus { label: string; hint: string }

/** A thread watching a request is not done: its rail row says Waiting, as T3 Code's does for a monitor. */
export function watchRowStatuses(watches: readonly PullRequestWatch[]): Record<string, WatchRowStatus> {
  const byThread = new Map<string, number[]>();
  for (const watch of watches) {
    if (watch.status !== "watching") continue;
    byThread.set(watch.threadId, [...byThread.get(watch.threadId) ?? [], watch.ref.number]);
  }
  return Object.fromEntries([...byThread].map(([threadId, numbers]) => [threadId, {
    label: "Waiting",
    hint: `Watching ${numbers.map((number) => `#${number}`).join(", ")}: wakes when checks finish, a review arrives or it merges.`,
  }]));
}
