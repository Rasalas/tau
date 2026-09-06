/**
 * Review Kit's contract between its host entry and its desktop entry, and the
 * few Workspace Kit facts it stands on. The desktop side gathers the diff and
 * picks the model; the host side asks the model for a commit message.
 */
export const REVIEW_HOST_EXTENSION_ID = "tau.review";

/** The overlay the review command opens; Workspace Kit opens it by this id too. */
export const REVIEW_OVERLAY = "review.workspace";

/** Review Kit's panel in the instrument dock. */
export const REVIEW_CHANGES_PANEL = "changes";

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";

export interface ReviewHostCommands {
  "suggest-commit-message": {
    input: {
      provider: string;
      modelId: string;
      style: CommitMessageStyle;
      branch?: string;
      files: Array<{ path: string; added: number; removed: number }>;
      diffs: Array<{ path: string; patch: string }>;
    };
    output: { message: string };
  };
}

/**
 * What Review needs from Workspace Kit: its extension id and the two commands
 * that answer with changes and with one file's diff. Ticket 06 owns
 * `kits/workspace/protocol.ts`; when it lands, these three declarations are
 * replaced by an import from it and nothing else here moves.
 */
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

export const WORKSPACE_CHANGES_COMMAND = "changes";
export const WORKSPACE_FILE_DIFF_COMMAND = "file-diff";
