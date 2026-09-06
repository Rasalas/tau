/**
 * Review Kit's contract between its host entry and its desktop entry, and the
 * Workspace Kit facts it stands on. The desktop side gathers the diff and
 * picks the model; the host side asks the model for a commit message.
 */
export const REVIEW_HOST_EXTENSION_ID = "tau.review";

// Review reads the worktree Workspace Kit owns: its host entry answers with
// changes and diffs, its store arrives as a service, and it opens the review
// overlay by this id, so the id is that kit's to name.
export {
  WORKSPACE_CHANGES_PANEL,
  WORKSPACE_HOST_EXTENSION_ID,
  WORKSPACE_REVIEW_OVERLAY as REVIEW_OVERLAY,
  WORKSPACE_STORE_SERVICE,
  type WorkspaceStoreApi,
} from "../workspace/protocol.js";

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";
