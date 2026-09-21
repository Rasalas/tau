import type { ComponentType } from "react";
import type { UiEditor, UiFileDiff, UiReviewRequest, UiSession, UiWorkspaceChanges, WorkbenchActions } from "tau";

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
  refresh(): Promise<void>;
  registerChangesSection(section: ComponentType<{ message: string; committed(): void }>): () => void;
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
}

/** The slice of Workspace Kit's `review-request-context` answer Review reads. */
export interface ReviewRequestContext {
  root: string;
  branch?: string;
  remote?: { name: string; url: string };
  upstream?: string;
  ahead?: number;
  base: string;
  commits?: Array<{ subject: string; body: string }>;
  diffStat?: string;
  template?: string;
}

export type RequestService = "github" | "gitlab";
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * Where the current branch stands on the way to a merged request: its Git
 * facts, the request when one exists, and the first thing missing for the
 * next step (no branch, no remote, no CLI, no login), in words for the user.
 */
export interface ReviewRequestStatus {
  branch?: string;
  /** The branch a new request merges into. */
  base: string;
  remote?: string;
  upstream?: string;
  ahead?: number;
  service: RequestService;
  request?: UiReviewRequest;
  problem?: string;
}

export interface ReviewRequestDraft {
  title: string;
  body: string;
  base: string;
  /** The model wrote it; false when the commits alone had to do. */
  generated: boolean;
}

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";
