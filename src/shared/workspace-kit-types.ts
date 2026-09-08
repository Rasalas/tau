/**
 * Types of the Workspace Kit's wire: changed files, diffs, worktrees, editors.
 * Core does not read them; kits import them through workspace-kit-protocol.
 */
export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface UiChangedFile {
  /** Repo-relative path. */
  path: string;
  name: string;
  directory: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  /** At least one index-side change exists for this path. */
  staged?: boolean;
  /** Why a historical diff cannot be opened for this entry, when applicable. */
  note?: string;
}

export type WorkspaceChangesCompleteness = "complete" | "partial";
export type WorkspaceDiffScope = "worktree" | "branch";

export interface WorkspaceChangesQuery {
  scope?: WorkspaceDiffScope;
  /** Optional comparison ref. The host resolves its merge base with HEAD. */
  baseRef?: string;
}

/** The pull or merge request a branch belongs to, as `gh` or `glab` report it. */
export interface UiReviewRequest {
  provider: "github" | "gitlab";
  number: number;
  title: string;
  url: string;
  /** Branch the request merges into; the branch diff uses it as base. */
  baseRef: string;
  headRef?: string;
}

export interface UiWorkspaceChanges {
  branch?: string;
  scope?: WorkspaceDiffScope;
  /** Resolved comparison ref for branch-wide changes. */
  baseRef?: string;
  /** The request the base came from, when the branch has one. */
  request?: UiReviewRequest;
  /** Resolved merge-base commit reused by lazy per-file diffs. */
  baseCommit?: string;
  /** Last refresh outcome; stale data may remain visible after a failed scan. */
  refreshStatus?: { state: "ready" | "refreshing" | "error"; message?: string };
  files: UiChangedFile[];
  /** Optional total when `files` is only a bounded preview. */
  fileCount?: number;
  /** Partial means the snapshot backend could not inspect the complete workspace. */
  completeness?: WorkspaceChangesCompleteness;
  /** Human-readable bounded explanation for omitted or content-unavailable files. */
  incompleteReason?: string;
  /** Number of files known to be omitted from the snapshot scan. */
  omittedFileCount?: number;
  added: number;
  removed: number;
  /** Derived from the changed paths — a starting point, not a generated message. */
  proposedMessage?: string;
}

/** A lazy page of files belonging to one immutable turn snapshot pair. */
export interface UiWorkspaceChangesPage extends UiWorkspaceChanges {
  /** Total number of changed files across all pages. */
  fileCount: number;
  /** Cursor used to request this page. */
  cursor?: string;
  /** Cursor for the next page, when more files remain. */
  nextCursor?: string;
  hasMore: boolean;
}

export type DiffLineKind = "context" | "added" | "removed";

export interface UiDiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface UiDiffHunk {
  header: string;
  lines: UiDiffLine[];
}

export interface DiffLoadOptions {
  /** Zero-based hunk page. The host still enforces its byte and line ceilings. */
  hunkOffset?: number;
  hunkLimit?: number;
  /** Git context lines around each hunk. The host clamps this value. */
  contextLines?: number;
  scope?: WorkspaceDiffScope;
  baseRef?: string;
  baseCommit?: string;
}

export interface UiFileDiff {
  path: string;
  added: number;
  removed: number;
  hunks: UiDiffHunk[];
  note?: string;
  truncated?: boolean;
  nextHunkOffset?: number;
}

export interface UiFileContent {
  /** Absolute path inside the workspace. */
  path: string;
  name: string;
  size: number;
  kind: "text" | "image" | "binary";
  /** text only; cut at the host's byte ceiling when `truncated`. */
  text?: string;
  language?: string;
  truncated?: boolean;
  /** image only. */
  dataUrl?: string;
}

export interface UiWorktree {
  path: string;
  name: string;
  branch?: string;
  /** The repository's primary checkout, as opposed to an added worktree. */
  isMain: boolean;
  isCurrent: boolean;
}

export interface UiRef {
  name: string;
  isCurrent: boolean;
  /** Set when this ref is already checked out in a worktree. */
  worktreePath?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommitAt?: number;
}

/** Expensive safety facts loaded only while the worktree picker is open. */
export interface UiWorktreeStatus {
  path: string;
  isDirty?: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  threadCount: number;
  lastCommitAt?: number;
  /** A conservative suggestion only. Tau never removes the worktree automatically. */
  cleanupCandidate: boolean;
  inspectionError?: string;
}

export interface WorkspaceInfo {
  /** Last refresh outcome; metadata may remain stale after a failed scan. */
  refreshStatus?: { state: "ready" | "refreshing" | "error"; message?: string };
  root: string;
  isRepo: boolean;
  /** Uncommitted changes present, which blocks an in-place ref switch. */
  isDirty: boolean;
  branch?: string;
  /** Tracking ref and divergence used to choose a safe primary Git action. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  hasRemote?: boolean;
  worktrees: UiWorktree[];
  refs: UiRef[];
  /** Where a new worktree would be created. */
  worktreeParent: string;
}

export interface UiEditor {
  id: string;
  name: string;
}

export interface CommitResult {
  changes: UiWorkspaceChanges;
  pushed: boolean;
  detail: string;
}

export interface PullResult {
  detail: string;
}

export interface PushResult {
  detail: string;
}
