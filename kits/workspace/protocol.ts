// Every import here is type-only on purpose: this file is read by the host half
// (esbuild, through `tau/host-extension`), by the desktop half (`tau`) and by
// other kits. Both bundlers erase `import type` without resolving it.
import type {
  CommitResult,
  DiffLoadOptions,
  FileNode,
  HostActionResult,
  MenuSection,
  UiEditor,
  UiTerminal,
  UiFileContent,
  UiFileDiff,
  UiFileStat,
  UiFileWriteResult,
  UiReviewRequest,
  UiSession,
  UiWorktreeStatus,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  PullResult,
  PushResult,
  WorkbenchActions,
  WorkspaceChangesQuery,
  WorkspaceInfo,
  WorkspaceRef,
} from "tau";
import type { ComponentType } from "react";
import type { TurnCheckpointStatus, UiTurnCheckpoint } from "./turn-checkpoint-types.js";

export const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

/** Where in a file an editor opens it, 1-based. */
export interface EditorPosition {
  line?: number;
  column?: number;
}

/** Where a new worktree starts, as the picker shows it. */
export interface UiWorktreeBase {
  ref: string;
  commit: string;
  shortCommit: string;
  /** The commit came from a freshly fetched remote-tracking ref. */
  fromOrigin: boolean;
  /** Why the base is not the one that was asked for. */
  note?: string;
}

/** What removing a worktree would lose. */
export interface UiWorktreeRemoval {
  path: string;
  branch?: string;
  dirtyFiles: number;
  ahead: number;
}

/**
 * What a project says about new threads, from `.tau/project.json`. A repository
 * can check the answer in, the way T3 Code reads `t3.json`.
 */
export interface ProjectDefaults {
  /** Where a new thread runs: the checkout it was started from, or its own worktree. */
  workspaceMode?: WorkspaceMode;
  /**
   * Shell command run in a new worktree, with TAU_PROJECT_ROOT and TAU_WORKTREE_PATH.
   * The old spelling: Project Scripts runs it as a script when it is on.
   */
  runOnWorktreeCreate?: string;
  /**
   * Directory where worktrees are placed: "beside" (default: <repo>-worktrees beside
   * the repository) or a directory path (e.g. "~/.tau/worktrees" or an absolute path).
   */
  worktreeDirectory?: string;
}

/** Project Scripts' host entry; it runs a new worktree's setup scripts when it is on. */
export const PROJECT_SCRIPTS_HOST_EXTENSION_ID = "tau.project-scripts";

/** Per-thread workspace choice, made before the first turn and locked after it. */
export type WorkspaceMode = "current" | "worktree";

/** Published for every checkpoint the host records or whose capture status changes. */
export const CHECKPOINT_EVENT = "checkpoint";

export interface WorkspaceCheckpointList {
  checkpoints: UiTurnCheckpoint[];
  /** Whether completed checkpoints can restore this thread; false while Pi owns it. */
  restoreSupported: boolean;
}

export type CheckpointEvent =
  | { type: "turn-checkpoint"; sessionId: string; checkpoint: UiTurnCheckpoint }
  | { type: "turn-checkpoint-status"; sessionId: string; turnId: string; status: TurnCheckpointStatus }
  | { type: "turn-checkpoint-error"; sessionId: string; turnId: string; message: string };

/** Panels, regions, overlays and commands the kit fills, named once. */
export const WORKSPACE_FILES_PANEL = "files";
export const WORKSPACE_CHANGES_PANEL = "changes";
/** Filled by Review Kit, opened by this kit; the id belongs to whoever asks for it. */
export const WORKSPACE_REVIEW_OVERLAY = "review.workspace";
export const WORKSPACE_CHECKPOINT_REVIEW_OVERLAY = "workspace.checkpoint-review";

export interface UiDirectoryListing {
  /** Host coordinates of the browsed folder; browsing is a host-side operation. */
  path: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
  /** How the client names this folder once it keeps it. */
  workspace: WorkspaceRef;
}

/**
 * The Git facts a pull or merge request is opened from. `base` is the branch a
 * new request merges into (`origin/HEAD`, then main or master); `detail` adds
 * the commits since it, a diff stat and the repository's request template.
 */
export interface ReviewRequestContext {
  root: string;
  branch?: string;
  remote?: { name: string; url: string };
  upstream?: string;
  /** Commits not yet on the upstream; set with `upstream`. */
  ahead?: number;
  base: string;
  commits?: Array<{ subject: string; body: string }>;
  diffStat?: string;
  template?: string;
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
  "file-stat": { input: { relPath: string }; output: UiFileStat };
  /** `expectedMtimeMs` is when the caller last saw the file; `null` expects none, absent writes regardless. */
  "write-file": { input: { relPath: string; text: string; expectedMtimeMs?: number | null }; output: UiFileWriteResult };
  "commit": { input: { message: string; push: boolean }; output: CommitResult };
  "pull": { input: undefined; output: PullResult };
  /** Pushes the branch; one without an upstream is published to the primary remote. Review Kit may call it. */
  "push": { input: undefined; output: PushResult };
  /** Review Kit's reading of the branch before it opens a request (callers: `tau.review`). */
  "review-request-context": { input: { detail?: boolean; base?: string } | undefined; output: ReviewRequestContext };
  /** The branch's pull or merge request as `gh`/`glab` report it; `fresh` skips the short cache (callers: `tau.review`). */
  "review-request": { input: { workspace?: string; fresh?: boolean } | undefined; output: UiReviewRequest | undefined };
  /** Reads metadata for a known project without changing the active host workspace. */
  "workspace-info": { input: { workspace?: string } | undefined; output: WorkspaceInfo };
  /** Reads every linked checkout only when the picker needs cleanup safety facts. */
  "worktree-statuses": { input: { workspace?: string } | undefined; output: UiWorktreeStatus[] };
  /** Where a new worktree would start: the base ref, the commit it resolves to, and whether that came from origin. */
  "worktree-base": { input: { workspace?: string; baseRef?: string; startFromOrigin?: boolean } | undefined; output: UiWorktreeBase };
  /** Adds a worktree next to `workspace` (the host's own by default) and answers with its identity; opening it is the caller's move. */
  "create-worktree": { input: { branch: string; baseRef?: string; startFromOrigin?: boolean; workspace?: string }; output: WorkspaceRef };
  /** What removing a worktree would lose: uncommitted files and commits beyond its base. */
  "worktree-removal-preview": { input: { path: string; workspace?: string }; output: UiWorktreeRemoval };
  /** Removes a linked worktree and the branch it held; the caller confirmed what the preview named. */
  "remove-worktree": { input: { path: string; branch?: string; workspace?: string }; output: void };
  /** Recreates a worktree whose folder vanished, so opening it still works; `true` when it had to. */
  "ensure-worktree": { input: { path: string; branch?: string; workspace?: string }; output: boolean };
  /** Defaults a project checks in under `.tau/project.json`, plus this client's own. */
  "project-defaults": { input: { workspace?: string } | undefined; output: ProjectDefaults };
  "switch-ref": { input: { ref: string }; output: HostActionResult };
  "list-editors": { input: undefined; output: UiEditor[] };
  /** `file-manager` reveals the file in Finder, Explorer or Files; a line reaches editors that take one. */
  "open-in-editor": { input: { editorId: string; relPath?: string; workspace?: string } & EditorPosition; output: void };
  "list-terminals": { input: undefined; output: UiTerminal[] };
  "open-terminal": { input: { terminalId?: string; workspace?: string }; output: void };
  /** Every checkpoint of a thread's branch, and whether this runtime can restore one. */
  "checkpoints": { input: { sessionId: string }; output: WorkspaceCheckpointList };
  /** Ref and workspace integrity check used before showing Restore. */
  "can-restore": { input: { sessionId: string; checkpointId: string }; output: boolean };
  /** Exact live-workspace delta that restoring a checkpoint would replace. */
  "restore-preview": { input: { sessionId: string; checkpointId: string }; output: UiWorkspaceChanges };
  "restore": { input: { sessionId: string; checkpointId: string }; output: HostActionResult };
  /** Conversation only: a new branch at the checkpoint, files untouched. Its own command, so an older host refuses rather than restores. */
  "rewind": { input: { sessionId: string; checkpointId: string }; output: HostActionResult };
  /** Immutable diff captured for one completed turn; never the live workspace. */
  "turn-file-diff": { input: { sessionId: string; checkpointId: string; relPath: string; options?: DiffLoadOptions }; output: UiFileDiff };
  "turn-files": { input: { sessionId: string; checkpointId: string; cursor?: string; limit?: number }; output: UiWorkspaceChangesPage };
}

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
  statFile(relPath: string): Promise<UiFileStat>;
  writeFile(relPath: string, text: string, expectedMtimeMs?: number | null): Promise<UiFileWriteResult>;
  commit(message: string, push: boolean): Promise<CommitResult>;
  pull(): Promise<PullResult>;
  push(): Promise<PushResult>;
  getWorkspaceInfo(workspace?: string): Promise<WorkspaceInfo>;
  getWorktreeStatuses(workspace?: string): Promise<UiWorktreeStatus[]>;
  getWorktreeBase(workspace?: string, options?: { baseRef?: string; startFromOrigin?: boolean }): Promise<UiWorktreeBase>;
  createWorktree(branch: string, options?: { baseRef?: string; startFromOrigin?: boolean }, workspace?: string): Promise<WorkspaceRef>;
  getWorktreeRemoval(path: string, workspace?: string): Promise<UiWorktreeRemoval>;
  removeWorktree(path: string, branch?: string, workspace?: string): Promise<void>;
  ensureWorktree(path: string, branch?: string, workspace?: string): Promise<boolean>;
  getProjectDefaults(workspace?: string): Promise<ProjectDefaults>;
  switchRef(ref: string): Promise<HostActionResult>;
  listEditors(): Promise<UiEditor[]>;
  openInEditor(editorId: string, relPath?: string, workspace?: string, position?: EditorPosition): Promise<void>;
  listTerminals(): Promise<UiTerminal[]>;
  openTerminal(terminalId?: string, workspace?: string): Promise<void>;
  checkpoints(sessionId: string): Promise<WorkspaceCheckpointList>;
  canRestoreCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;
  getRestorePreview(sessionId: string, checkpointId: string): Promise<UiWorkspaceChanges>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<HostActionResult>;
  rewindCheckpoint(sessionId: string, checkpointId: string): Promise<HostActionResult>;
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
    statFile: (relPath) => call("file-stat", { relPath }),
    writeFile: (relPath, text, expectedMtimeMs) => call("write-file", expectedMtimeMs === undefined ? { relPath, text } : { relPath, text, expectedMtimeMs }),
    commit: (message, push) => call("commit", { message, push }),
    pull: () => call("pull", undefined),
    push: () => call("push", undefined),
    getWorkspaceInfo: (workspace) => call("workspace-info", workspace === undefined ? undefined : { workspace }),
    getWorktreeStatuses: (workspace) => call("worktree-statuses", workspace === undefined ? undefined : { workspace }),
    getWorktreeBase: (workspace, options) => call("worktree-base", { workspace, ...options }),
    createWorktree: (branch, options, workspace) => call("create-worktree", { branch, ...options, workspace }),
    getWorktreeRemoval: (path, workspace) => call("worktree-removal-preview", { path, workspace }),
    removeWorktree: (path, branch, workspace) => call("remove-worktree", { path, branch, workspace }),
    ensureWorktree: (path, branch, workspace) => call("ensure-worktree", { path, branch, workspace }),
    getProjectDefaults: (workspace) => call("project-defaults", { workspace }),
    switchRef: (ref) => call("switch-ref", { ref }),
    listEditors: () => call("list-editors", undefined),
    openInEditor: (editorId, relPath, workspace, position) => call("open-in-editor", { editorId, relPath, workspace, ...position }),
    listTerminals: () => call("list-terminals", undefined),
    openTerminal: (terminalId, workspace) => call("open-terminal", { terminalId, workspace }),
    checkpoints: (sessionId) => call("checkpoints", { sessionId }),
    canRestoreCheckpoint: (sessionId, checkpointId) => call("can-restore", { sessionId, checkpointId }),
    getRestorePreview: (sessionId, checkpointId) => call("restore-preview", { sessionId, checkpointId }),
    restoreCheckpoint: (sessionId, checkpointId) => call("restore", { sessionId, checkpointId }),
    rewindCheckpoint: (sessionId, checkpointId) => call("rewind", { sessionId, checkpointId }),
    getTurnFileDiff: (sessionId, checkpointId, relPath, options) => call("turn-file-diff", { sessionId, checkpointId, relPath, options }),
    getTurnFiles: (sessionId, checkpointId, cursor, limit) => call("turn-files", { sessionId, checkpointId, cursor, limit }),
  };
}

/**
 * The id Workspace Kit publishes its store under, through
 * `context.provideService`. Another kit reaches it with
 * `context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, …)`, which
 * resolves whichever kit activates first.
 */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";

/** What the kit knows about the project the workbench is showing. */
export interface WorkspaceKitState {
  /** The project the store follows: the draft's project while a new thread is pending, else the thread's. */
  cwd?: string;
  /** How the host names that project; what every command sends back. */
  workspaceId?: string;
  draftPending: boolean;
  changes: UiWorkspaceChanges;
  workspace?: WorkspaceInfo;
  workspaceBusy: boolean;
  editors: UiEditor[];
  terminals: UiTerminal[];
  fileTree: FileNode[];
  committing: boolean;
  pushPrimary: boolean;
  commitFocusToken: number;
  /** Changes at the start of the running turn, so the dock can show what the turn touched. */
  turnBaseline?: UiWorkspaceChanges;
  /** The turn is over; the dock yields to the transcript's checkpoint card. */
  turnSettled: boolean;
  review?: { path?: string; primaryPush: boolean };
  /** An extension offers to name new worktrees. */
  canNameWorktrees: boolean;
  /** Where the next thread of this draft runs; locked once the thread exists. */
  workspaceMode: WorkspaceMode;
  /** Where a new worktree would start, as the picker shows it. */
  worktreeBase?: UiWorktreeBase;
  /** A worktree is being created for the thread that is starting. */
  preparingWorktree: boolean;
  /** Sections other kits add to the Changes panel. */
  changesSections: ReadonlyArray<ComponentType<ChangesSectionProps>>;
  /** Marks other kits add to rail rows. */
  threadRowAccessories: ReadonlyArray<ComponentType<ThreadRowAccessoryProps>>;
  /** Another kit's say over the rail's sections, menus and drops. */
  threadRailOrganizer?: ThreadRailOrganizer;
}

export interface WorktreeNameRequest {
  /** What the user typed into the worktree search, if anything. */
  hint: string;
  /** The unsent composer text describing the task. */
  description: string;
  /** Branch names already in the repository. */
  taken: string[];
  actions: WorkbenchActions;
}

export type WorktreeNamer = (request: WorktreeNameRequest) => Promise<string>;

/** What the Changes panel hands a section another kit contributes. */
export interface ChangesSectionProps {
  actions: WorkbenchActions;
  /** The commit message as the user left it in the box. */
  message: string;
  /** Tell the box a commit went through, so it follows the next proposal again. */
  committed(): void;
}

/** A small mark another kit draws on a thread's rail row, e.g. its request status. */
export interface ThreadRowAccessoryProps {
  session: UiSession;
}

/** One run of the rail: a heading and its threads, in the order they are drawn. */
export interface ThreadRailSection {
  id: string;
  /** Drawn above the threads; the one section without a label is the rail's main, paged list. */
  label?: string;
  threads: readonly UiSession[];
  /** A shelf folds away under its label and draws compact rows. */
  shelf?: boolean;
  /** A shelf that starts folded. */
  collapsed?: boolean;
  /** Rows drawn the settled way, with the button that brings them back. */
  settled?: boolean;
}

/** Where a dragged thread would land: a section, and the thread it would go before. */
export interface ThreadRailDrop {
  sectionId: string;
  /** Absent means the end of the section. */
  beforeThreadId?: string;
}

/**
 * Another kit's say over the rail: which section a thread is in and in what
 * order, what a row's menu offers and what a drop means. The rail keeps the
 * search, the paging, the rows and the gestures. One at a time; the last wins.
 */
export interface ThreadRailOrganizer {
  subscribe(listener: () => void): () => void;
  /** Moves whenever `sections` would answer differently for the same threads. */
  getVersion(): number;
  /** `threads` is what the rail would show, searched and newest first. */
  sections(threads: readonly UiSession[]): ThreadRailSection[];
  /** A row's right-click menu. */
  menu(session: UiSession): MenuSection[];
  runMenu(session: UiSession, itemId: string, actions: WorkbenchActions): void;
  /** The row's own settle button. */
  toggleSettled(session: UiSession): void;
  /** What dropping the thread there does, in a word; undefined when it may not land there. */
  dropLabel(threadId: string, drop: ThreadRailDrop): string | undefined;
  drop(threadId: string, drop: ThreadRailDrop): void;
  /** Drawn once inside the rail, for the organizer's own dialogs. */
  Layer?: ComponentType<{ actions: WorkbenchActions }>;
}

/** What a kit asks of `prepareThreadWorktree` beyond what the pending draft already says. */
export interface ThreadWorktreeRequest {
  prompt: string;
  preparing(message: string): void;
  /** Make one even when the draft runs in the current checkout. */
  force?: boolean;
  /** Appended to the branch name, so several worktrees for one prompt do not collide. */
  branchSuffix?: string;
}

/** Opens a workspace file, by its path inside the workspace, where it can be edited. */
export type WorkspaceFileEditor = (relPath: string, actions: WorkbenchActions) => void;

export type CommitMessageSuggester = (request: {
  changes: UiWorkspaceChanges;
  diffs: readonly UiFileDiff[];
  actions: WorkbenchActions;
}) => Promise<string>;

/**
 * What Workspace Kit lends the kits built on it. It is deliberately smaller
 * than the store itself: reading the followed project, opening review, and the
 * two offers another kit may fill (worktree names, commit messages).
 */
export interface WorkspaceStoreApi {
  getSnapshot(): WorkspaceKitState;
  /** Where a new thread of the followed project runs, and the choice for the pending draft. */
  workspaceMode(): WorkspaceMode;
  setWorkspaceMode(mode: WorkspaceMode): void;
  subscribe(listener: () => void): () => void;
  activeEditor(): UiEditor | undefined;
  openReview(path?: string, pushPrimary?: boolean): void;
  selectReviewPath(path: string): void;
  closeReview(): void;
  /** Commits the selected changes and reports whether the host accepted them. */
  commit(message: string, push: boolean): Promise<boolean>;
  openInEditor(relPath?: string, editorOverride?: string, position?: EditorPosition): Promise<void>;
  /** Makes an editor the one "Open in" uses first. */
  chooseEditor(id: string): void;
  activeTerminal(): UiTerminal | undefined;
  openTerminal(terminalOverride?: string): Promise<void>;
  suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined>;
  /** An extension offers to name new worktrees; the picker shows the offer only while one is registered. */
  registerWorktreeNamer(namer: WorktreeNamer): () => void;
  registerCommitMessageSuggester(suggester: CommitMessageSuggester): () => void;
  /** Re-reads the followed project's changes and Git facts, e.g. after another kit pushed. */
  refresh(): Promise<void>;
  /** An extension offers to open a file for editing: a double-click in the Files panel asks it. The last one wins. */
  registerFileEditor(editor: WorkspaceFileEditor): () => void;
  /** A section drawn at the top of the Changes panel, clean worktree or not. */
  registerChangesSection(section: ComponentType<ChangesSectionProps>): () => void;
  /** A mark drawn on every thread row of the rail. */
  registerThreadRowAccessory(accessory: ComponentType<ThreadRowAccessoryProps>): () => void;
  /** Sections, row menus and drops of the rail. */
  registerThreadRailOrganizer(organizer: ThreadRailOrganizer): () => void;
  /**
   * The worktree a new thread of the followed project runs in, created the way
   * the new-thread gate creates one: named by the naming kit when there is one.
   * Answers nothing, with a notice, when the project is no repository or the
   * worktree could not be made.
   */
  prepareThreadWorktree(request: ThreadWorktreeRequest): Promise<{ workspace?: { workspaceId: string; displayPath: string } }>;
}
