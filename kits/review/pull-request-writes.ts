import { useCommandAllowed } from "tau";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

/** What this device may change on a request; a Read-only device reads it only. */
export interface PullRequestWrites {
  comment: boolean;
  review: boolean;
  update: boolean;
  editComment: boolean;
  resolve: boolean;
  viewed: boolean;
  reviewers: boolean;
  labels: boolean;
  action: boolean;
  stack: boolean;
  link: boolean;
}

export const ALL_WRITES: PullRequestWrites = {
  comment: true, review: true, update: true, editComment: true, resolve: true, viewed: true,
  reviewers: true, labels: true, action: true, stack: true, link: true,
};

export function usePullRequestWrites(): PullRequestWrites {
  // One hook per command, always all of them, in this order.
  const allowed = (command: string) => useCommandAllowed(REVIEW_HOST_EXTENSION_ID, command);
  const unlink = allowed("unlink-pr");
  return {
    comment: allowed("pr-comment"),
    review: allowed("pr-review"),
    update: allowed("pr-update"),
    editComment: allowed("pr-edit-comment"),
    resolve: allowed("pr-resolve"),
    viewed: allowed("pr-viewed"),
    reviewers: allowed("pr-reviewers"),
    labels: allowed("pr-labels"),
    action: allowed("pr-action"),
    stack: allowed("pr-stack-action"),
    link: allowed("link-pr") && unlink,
  };
}
