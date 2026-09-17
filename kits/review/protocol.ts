import type { UiEditor, UiFileDiff, UiWorkspaceChanges, WorkbenchActions } from "tau";

export const REVIEW_HOST_EXTENSION_ID = "tau.review";
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export const WORKSPACE_CHANGES_PANEL = "changes";
export const REVIEW_OVERLAY = "review.workspace";

export interface WorkspaceStoreApi {
  getSnapshot(): {
    cwd?: string;
    workspaceId?: string;
    changes: UiWorkspaceChanges;
    committing: boolean;
    review?: { path?: string; primaryPush: boolean };
  };
  subscribe(listener: () => void): () => void;
  activeEditor(): UiEditor | undefined;
  openReview(path?: string, pushPrimary?: boolean): void;
  selectReviewPath(path: string): void;
  closeReview(): void;
  commit(message: string, push: boolean): Promise<boolean>;
  openInEditor(relPath?: string, editorOverride?: string): Promise<void>;
  suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined>;
  registerCommitMessageSuggester(suggester: (request: {
    changes: UiWorkspaceChanges;
    diffs: readonly UiFileDiff[];
    actions: WorkbenchActions;
  }) => Promise<string>): () => void;
}

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";
