import type {
  CommitResult,
  DiffLoadOptions,
  FileNode,
  PushResult,
  UiEditor,
  UiFileContent,
  UiFileDiff,
  UiWorkspaceChanges,
  WorkspaceChangesQuery,
  WorkspaceInfo,
} from "./contracts.js";
import type { HostActionResult } from "./host-protocol.js";

/**
 * Workspace Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

export interface WorkspaceHostCommands {
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
}

export type WorkspaceHostCommand = keyof WorkspaceHostCommands;

export type HostExtensionInvoke = (command: string, input?: unknown) => Promise<unknown>;

export interface WorkspaceHostClient {
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
}

/** Typed view over the untyped invoke channel, shared by the desktop entry and by tests. */
export function createWorkspaceHostClient(invoke: HostExtensionInvoke): WorkspaceHostClient {
  const call = <K extends WorkspaceHostCommand>(command: K, input: WorkspaceHostCommands[K]["input"]) =>
    invoke(command, input) as Promise<WorkspaceHostCommands[K]["output"]>;
  return {
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
  };
}
