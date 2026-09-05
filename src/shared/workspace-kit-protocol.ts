import type {
  CommitResult,
  DiffLoadOptions,
  FileNode,
  PushResult,
  UiEditor,
  UiFileContent,
  UiFileDiff,
  UiWorktreeStatus,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceInfo,
} from "./workspace-kit-types.js";
import type { TurnCheckpointStatus, UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import type { HostActionResult } from "./host-protocol.js";
import type { WorkspaceRef } from "./workspace-identity.js";

export type { FileNode, ChangeStatus, UiChangedFile, WorkspaceChangesCompleteness, WorkspaceDiffScope, WorkspaceChangesQuery, UiReviewRequest, UiWorkspaceChanges, UiWorkspaceChangesPage, DiffLineKind, UiDiffLine, UiDiffHunk, DiffLoadOptions, UiFileDiff, UiFileContent, UiWorktree, UiWorktreeStatus, UiRef, WorkspaceInfo, UiEditor, CommitResult, PushResult } from "./workspace-kit-types.js";

/**
 * Workspace Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

export interface UiDirectoryListing {
  /** Host coordinates of the browsed folder; browsing is a host-side operation. */
  path: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
  /** How the client names this folder once it keeps it. */
  workspace: WorkspaceRef;
}

/**
 * Workspace Kit's commands. A file inside a workspace travels as `relPath`, a
 * POSIX path relative to the workspace root; a workspace itself travels as the
 * opaque `workspace` id the host published. Only folder browsing deals in host
 * paths, and it answers with identities for whatever the client keeps.
 */
export interface WorkspaceHostCommands {
  /** Browses folders for the local-folder project source. */
  "list-directories": { input: { path?: string } | undefined; output: UiDirectoryListing };
  /** Native folder dialog; `undefined` when cancelled. */
  "pick-folder": { input: undefined; output: WorkspaceRef | undefined };
  /** Clones into `parentPath`, or into a folder the host's picker returns; `undefined` when that dialog was cancelled. */
  "clone": { input: { repositoryUrl: string; parentPath?: string }; output: WorkspaceRef | undefined };
  "file-tree": { input: { relPath?: string } | undefined; output: FileNode[] };
  "changes": { input: { query?: WorkspaceChangesQuery } | undefined; output: UiWorkspaceChanges };
  "file-diff": { input: { relPath: string; options?: DiffLoadOptions }; output: UiFileDiff };
  "stage-file": { input: { relPath: string }; output: UiWorkspaceChanges };
  "unstage-file": { input: { relPath: string }; output: UiWorkspaceChanges };
  "stage-all": { input: undefined; output: UiWorkspaceChanges };
  "revert-file": { input: { relPath: string }; output: UiWorkspaceChanges };
  "read-file": { input: { relPath: string }; output: UiFileContent };
  "commit": { input: { message: string; push: boolean }; output: CommitResult };
  "push": { input: undefined; output: PushResult };
  /** Reads metadata for a known project without changing the active host workspace. */
  "workspace-info": { input: { workspace?: string } | undefined; output: WorkspaceInfo };
  /** Reads every linked checkout only when the picker needs cleanup safety facts. */
  "worktree-statuses": { input: { workspace?: string } | undefined; output: UiWorktreeStatus[] };
  /** Adds a worktree next to `workspace` (the host's own by default) and answers with its identity; opening it is the caller's move. */
  "create-worktree": { input: { branch: string; baseRef?: string; workspace?: string }; output: WorkspaceRef };
  "switch-ref": { input: { ref: string }; output: HostActionResult };
  "list-editors": { input: undefined; output: UiEditor[] };
  "open-in-editor": { input: { editorId: string; relPath?: string }; output: void };
  /** Every checkpoint of a thread's branch, and whether this runtime can restore one. */
  "checkpoints": { input: { sessionId: string }; output: WorkspaceCheckpointList };
  /** Ref and workspace integrity check used before showing Restore. */
  "can-restore": { input: { sessionId: string; checkpointId: string }; output: boolean };
  /** Exact live-workspace delta that restoring a checkpoint would replace. */
  "restore-preview": { input: { sessionId: string; checkpointId: string }; output: UiWorkspaceChanges };
  "restore": { input: { sessionId: string; checkpointId: string }; output: HostActionResult };
  /** Immutable diff captured for one completed turn; never the live workspace. */
  "turn-file-diff": { input: { sessionId: string; checkpointId: string; relPath: string; options?: DiffLoadOptions }; output: UiFileDiff };
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
  | { type: "turn-checkpoint-status"; sessionId: string; turnId: string; status: TurnCheckpointStatus }
  | { type: "turn-checkpoint-error"; sessionId: string; turnId: string; message: string };

export type WorkspaceHostCommand = keyof WorkspaceHostCommands;

export type HostExtensionInvoke = (command: string, input?: unknown) => Promise<unknown>;

export interface WorkspaceHostClient {
  listDirectories(path?: string): Promise<UiDirectoryListing>;
  pickFolder(): Promise<WorkspaceRef | undefined>;
  clone(repositoryUrl: string, parentPath?: string): Promise<WorkspaceRef | undefined>;
  getFileTree(relPath?: string): Promise<FileNode[]>;
  getChanges(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  getFileDiff(relPath: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  stageFile(relPath: string): Promise<UiWorkspaceChanges>;
  unstageFile(relPath: string): Promise<UiWorkspaceChanges>;
  stageAll(): Promise<UiWorkspaceChanges>;
  revertFile(relPath: string): Promise<UiWorkspaceChanges>;
  readFile(relPath: string): Promise<UiFileContent>;
  commit(message: string, push: boolean): Promise<CommitResult>;
  push(): Promise<PushResult>;
  getWorkspaceInfo(workspace?: string): Promise<WorkspaceInfo>;
  getWorktreeStatuses(workspace?: string): Promise<UiWorktreeStatus[]>;
  createWorktree(branch: string, baseRef?: string, workspace?: string): Promise<WorkspaceRef>;
  switchRef(ref: string): Promise<HostActionResult>;
  listEditors(): Promise<UiEditor[]>;
  openInEditor(editorId: string, relPath?: string): Promise<void>;
  checkpoints(sessionId: string): Promise<WorkspaceCheckpointList>;
  canRestoreCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;
  getRestorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  getTurnFileDiff(sessionId: string, checkpointId: string, relPath: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  getTurnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

/** Typed view over the untyped invoke channel, shared by the desktop entry and by tests. */
export function createWorkspaceHostClient(invoke: HostExtensionInvoke): WorkspaceHostClient {
  const call = <K extends WorkspaceHostCommand>(command: K, input: WorkspaceHostCommands[K]["input"]) =>
    invoke(command, input) as Promise<WorkspaceHostCommands[K]["output"]>;
  return {
    listDirectories: (path) => call("list-directories", path === undefined ? undefined : { path }),
    pickFolder: () => call("pick-folder", undefined),
    clone: (repositoryUrl, parentPath) => call("clone", parentPath === undefined ? { repositoryUrl } : { repositoryUrl, parentPath }),
    getFileTree: (relPath) => call("file-tree", relPath === undefined ? undefined : { relPath }),
    getChanges: (query) => call("changes", query === undefined ? undefined : { query }),
    getFileDiff: (relPath, options) => call("file-diff", { relPath, options }),
    stageFile: (relPath) => call("stage-file", { relPath }),
    unstageFile: (relPath) => call("unstage-file", { relPath }),
    stageAll: () => call("stage-all", undefined),
    revertFile: (relPath) => call("revert-file", { relPath }),
    readFile: (relPath) => call("read-file", { relPath }),
    commit: (message, push) => call("commit", { message, push }),
    push: () => call("push", undefined),
    getWorkspaceInfo: (workspace) => call("workspace-info", workspace === undefined ? undefined : { workspace }),
    getWorktreeStatuses: (workspace) => call("worktree-statuses", workspace === undefined ? undefined : { workspace }),
    createWorktree: (branch, baseRef, workspace) => call("create-worktree", { branch, baseRef, workspace }),
    switchRef: (ref) => call("switch-ref", { ref }),
    listEditors: () => call("list-editors", undefined),
    openInEditor: (editorId, relPath) => call("open-in-editor", { editorId, relPath }),
    checkpoints: (sessionId) => call("checkpoints", { sessionId }),
    canRestoreCheckpoint: (sessionId, checkpointId) => call("can-restore", { sessionId, checkpointId }),
    getRestorePreview: (sessionId, checkpointId) => call("restore-preview", { sessionId, checkpointId }),
    restoreCheckpoint: (sessionId, checkpointId) => call("restore", { sessionId, checkpointId }),
    getTurnFileDiff: (sessionId, checkpointId, relPath, options) => call("turn-file-diff", { sessionId, checkpointId, relPath, options }),
    getTurnFiles: (sessionId, checkpointId, cursor, limit) => call("turn-files", { sessionId, checkpointId, cursor, limit }),
  };
}
