import { READ_ONLY_REASON } from "tau";
import type { LocalReview } from "./local-reviews.js";

/** What the list and the review say alike. */
export const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Why a branch counts as merged without a merge of its own commits. */
export const ALREADY: Record<NonNullable<LocalReview["mergedBy"]>, string> = {
  patches: "every commit's change is there already, under other commits (a cherry-pick, a rebase or rewritten history).",
  tree: "merging would change nothing (a squash merge).",
  request: "its pull request was merged on the host.",
};

/** Why the thread cannot be asked to rebase: one on another machine does not see this checkout's branch. */
export const rebaseBlocker = (review: LocalReview, mayAsk: boolean) => !mayAsk ? READ_ONLY_REASON
  : review.remote ? `The thread runs on ${review.remote.machine}, where ${review.target} is not this checkout's; merge it by hand or send a note.`
  : !review.threadId ? "No thread works on this branch any more."
  : undefined;
