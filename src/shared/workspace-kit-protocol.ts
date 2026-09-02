import type {
  CommitResult,
  DiffLoadOptions,
  FileNode,
  PushResult,
  UiEditor,
  UiFileContent,
  UiFileDiff,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceInfo,
} from "./workspace-kit-types.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import type { HostActionResult } from "./host-protocol.js";

export type { FileNode, ChangeStatus, UiChangedFile, WorkspaceChangesCompleteness, WorkspaceDiffScope, WorkspaceChangesQuery, UiReviewRequest, UiWorkspaceChanges, UiWorkspaceChangesPage, DiffLineKind, UiDiffLine, UiDiffHunk, DiffLoadOptions, UiFileDiff, UiFileContent, UiWorktree, UiRef, WorkspaceInfo, UiEditor, CommitResult, PushResult } from "./workspace-kit-types.js";

/**
 * Workspace Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

export interface UiDirectoryListing {
  path: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
}

export interface WorkspaceHostCommands {
  /** Browses folders for the local-folder project source. */
  "list-directories": { input: { path?: string } | undefined; output: UiDirectoryListing };
  /** Native folder dialog; `undefined` when cancelled. */
  "pick-folder": { input: undefined; output: { path: string } | undefined };
  /** Clones into a chosen parent folder; `undefined` when the dialog was cancelled. */
  "clone": { input: { repositoryUrl: string }; output: { path: string } | undefined };
  "file-tree": { input: { path?: string } | undefined; output: FileNode[] };
  "changes": { input: { query?: WorkspaceChangesQuery } | undefined; output: UiWorkspaceChanges };
  "file-diff": { input: { path: string; options?: DiffLoadOptions }; output: UiFileDiff };
  "stage-file": { input: { path: string }; output: UiWorkspaceChanges };
  "unstage-file": { input: { path: string }; output: UiWorkspaceChanges };
  "stage-all": { input: undefined; output: UiWorkspaceChanges };
  "revert-file": { input: { path: string }; output: UiWorkspaceChanges };
  "read-file": { input: { path: string }; output: UiFileContent };
  "commit": { input: { message: string; push: boolean }; output: CommitResult };
  "push": { input: undefined; output: PushResult };
  /** Reads metadata for a known project without changing the active host workspace. */
  "workspace-info": { input: { cwd?: string } | undefined; output: WorkspaceInfo };
  "create-worktree": { input: { branch: string; baseRef?: string }; output: HostActionResult };
  "switch-ref": { input: { ref: string }; output: HostActionResult };
  "list-editors": { input: undefined; output: UiEditor[] };
  "open-in-editor": { input: { editorId: string; path?: string }; output: void };
  /** Every checkpoint of a thread's branch, and whether this runtime can restore one. */
  "checkpoints": { input: { sessionId: string }; output: WorkspaceCheckpointList };
  /** Ref and workspace integrity check used before showing Restore. */
  "can-restore": { input: { sessionId: string; checkpointId: string }; output: boolean };
  /** Exact live-workspace delta that restoring a checkpoint would replace. */
  "restore-preview": { input: { sessionId: string; checkpointId: string }; output: UiWorkspaceChanges };
  "restore": { input: { sessionId: string; checkpointId: string }; output: HostActionResult };
  /** Immutable diff captured for one completed turn; never the live workspace. */
  "turn-file-diff": { input: { sessionId: string; checkpointId: string; path: string; options?: DiffLoadOptions }; output: UiFileDiff };
  "turn-files": { input: { sessionId: string; checkpointId: string; cursor?: string; limit?: number }; output: UiWorkspaceChangesPage };
}

export interface WorkspaceCheckpointList {
  checkpoints: UiTurnCheckpoint[];
  /** Whether completed checkpoints can restore this thread; false while Pi owns it. */
  restoreSupported: boolean;
}

/** Published for every checkpoint the host records or whose capture status changes. */
export const CHECKPOINT_EVENT = "checkpoint";
export type CheckpointEvent =
  | { type: "turn-checkpoint"; sessionId: string; checkpoint: UiTurnCheckpoint }
  | { type: "turn-checkpoint-status"; sessionId: string; turnId: string; status: "queued" | "waiting" | "capturing" | "persisting" | "ready" | "failed" }
  | { type: "turn-checkpoint-error"; sessionId: string; turnId: string; message: string };

export type WorkspaceHostCommand = keyof WorkspaceHostCommands;

export type HostExtensionInvoke = (command: string, input?: unknown) => Promise<unknown>;

export interface WorkspaceHostClient {
  listDirectories(path?: string): Promise<UiDirectoryListing>;
  pickFolder(): Promise<string | undefined>;
  clone(repositoryUrl: string): Promise<string | undefined>;
  getFileTree(path?: string): Promise<FileNode[]>;
  getChanges(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  getFileDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  stageFile(path: string): Promise<UiWorkspaceChanges>;
  unstageFile(path: string): Promise<UiWorkspaceChanges>;
  stageAll(): Promise<UiWorkspaceChanges>;
  revertFile(path: string): Promise<UiWorkspaceChanges>;
  readFile(path: string): Promise<UiFileContent>;
  commit(message: string, push: boolean): Promise<CommitResult>;
  push(): Promise<PushResult>;
  getWorkspaceInfo(cwd?: string): Promise<WorkspaceInfo>;
  createWorktree(branch: string, baseRef?: string): Promise<HostActionResult>;
  switchRef(ref: string): Promise<HostActionResult>;
  listEditors(): Promise<UiEditor[]>;
  openInEditor(editorId: string, path?: string): Promise<void>;
  checkpoints(sessionId: string): Promise<WorkspaceCheckpointList>;
  canRestoreCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;
  getRestorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  getTurnFileDiff(sessionId: string, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  getTurnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

/** Typed view over the untyped invoke channel, shared by the desktop entry and by tests. */
export function createWorkspaceHostClient(invoke: HostExtensionInvoke): WorkspaceHostClient {
  const call = <K extends WorkspaceHostCommand>(command: K, input: WorkspaceHostCommands[K]["input"]) =>
    invoke(command, input) as Promise<WorkspaceHostCommands[K]["output"]>;
  return {
    listDirectories: (path) => call("list-directories", path === undefined ? undefined : { path }),
    pickFolder: () => call("pick-folder", undefined).then((result) => result?.path),
    clone: (repositoryUrl) => call("clone", { repositoryUrl }).then((result) => result?.path),
    getFileTree: (path) => call("file-tree", path === undefined ? undefined : { path }),
    getChanges: (query) => call("changes", query === undefined ? undefined : { query }),
    getFileDiff: (path, options) => call("file-diff", { path, options }),
    stageFile: (path) => call("stage-file", { path }),
    unstageFile: (path) => call("unstage-file", { path }),
    stageAll: () => call("stage-all", undefined),
    revertFile: (path) => call("revert-file", { path }),
    readFile: (path) => call("read-file", { path }),
    commit: (message, push) => call("commit", { message, push }),
    push: () => call("push", undefined),
    getWorkspaceInfo: (cwd) => call("workspace-info", cwd === undefined ? undefined : { cwd }),
    createWorktree: (branch, baseRef) => call("create-worktree", { branch, baseRef }),
    switchRef: (ref) => call("switch-ref", { ref }),
    listEditors: () => call("list-editors", undefined),
    openInEditor: (editorId, path) => call("open-in-editor", { editorId, path }),
    checkpoints: (sessionId) => call("checkpoints", { sessionId }),
    canRestoreCheckpoint: (sessionId, checkpointId) => call("can-restore", { sessionId, checkpointId }),
    getRestorePreview: (sessionId, checkpointId) => call("restore-preview", { sessionId, checkpointId }),
    restoreCheckpoint: (sessionId, checkpointId) => call("restore", { sessionId, checkpointId }),
    getTurnFileDiff: (sessionId, checkpointId, path, options) => call("turn-file-diff", { sessionId, checkpointId, path, options }),
    getTurnFiles: (sessionId, checkpointId, cursor, limit) => call("turn-files", { sessionId, checkpointId, cursor, limit }),
  };
}
