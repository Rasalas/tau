import type { HostActionResult } from "./host-protocol.js";

export type UiRole = "user" | "assistant" | "notice";

export interface UiMessage {
  id: string;
  role: UiRole;
  text: string;
  thinking?: string;
  timestamp: number;
}

export interface UiToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  output?: string;
  startedAt: number;
  endedAt?: number;
}

export interface UiModel {
  provider: string;
  id: string;
  name: string;
}

export interface UiSession {
  id: string;
  path: string;
  title: string;
  modifiedAt: number;
  projectPath: string;
  projectName: string;
  branch?: string;
  messageCount: number;
}

export interface UiProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
}

/** Context window usage for the active thread, as reported by the Pi session. */
export interface UiContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

/**
 * Pi itself has no permission model — every tool it is asked to run, runs.
 * Tau enforces these levels through an inline Pi extension that can block tool calls.
 */
export type AccessLevel = "read-only" | "ask" | "full";

export interface ToolApprovalRequest {
  id: string;
  toolName: string;
  /** Short human-readable description of what the tool is about to do. */
  summary: string;
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
}

export interface UiWorkspaceChanges {
  branch?: string;
  /** Last refresh outcome; stale data may remain visible after a failed scan. */
  refreshStatus?: { state: "ready" | "refreshing" | "error"; message?: string };
  files: UiChangedFile[];
  added: number;
  removed: number;
  /** Derived from the changed paths — a starting point, not a generated message. */
  proposedMessage?: string;
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
}

export interface WorkspaceInfo {
  /** Last refresh outcome; metadata may remain stale after a failed scan. */
  refreshStatus?: { state: "ready" | "refreshing" | "error"; message?: string };
  root: string;
  isRepo: boolean;
  /** Uncommitted changes present, which blocks an in-place ref switch. */
  isDirty: boolean;
  branch?: string;
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

export interface HostSnapshot {
  cwd: string;
  branch?: string;
  sessionId: string;
  sessionName?: string;
  sessionTitle: string;
  model?: UiModel;
  models: UiModel[];
  thinkingLevel: string;
  thinkingLevels: string[];
  messages: UiMessage[];
  isStreaming: boolean;
  activeTools: string[];
  allTools: Array<{ name: string; description: string }>;
  extensionCount: number;
  contextUsage?: UiContextUsage;
}

export interface ThreadIndexSnapshot {
  projects: UiProject[];
  sessions: UiSession[];
}

export interface HostBootstrap {
  threadIndex: ThreadIndexSnapshot;
  version: 1;
  detail: {
    sessionId: string;
    messages: UiMessage[];
    isStreaming: boolean;
    activeTools: string[];
    contextUsage?: UiContextUsage;
    olderCursor?: string;
  };
  catalog: {
    models: UiModel[];
    model?: UiModel;
    thinkingLevel: string;
    thinkingLevels: string[];
    allTools: Array<{ name: string; description: string }>;
    extensionCount: number;
  };
  project: { cwd: string; branch?: string };
}

export type HostEvent =
  | { type: "host-update"; update: import("./host-protocol.js").HostUpdate }
  | { type: "thread-index"; threadIndex: ThreadIndexSnapshot }
  | { type: "agent-status"; sessionId: string; running: boolean }
  | { type: "assistant-start"; id: string; timestamp: number }
  | { type: "assistant-delta"; id: string; delta: string }
  | { type: "assistant-thinking"; id: string; delta: string }
  | { type: "assistant-end"; message: UiMessage }
  | { type: "tool-start"; tool: UiToolRun }
  | { type: "tool-update"; id: string; output: string }
  | { type: "tool-end"; tool: UiToolRun }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "tool-approval"; request: ToolApprovalRequest }
  | { type: "error"; message: string }
  | { type: "event-log"; label: string; detail?: string; timestamp: number };

export interface TauDesktopApi {
  /** Host platform, so the title bar can leave room for native window controls. */
  readonly platform: string;
  bootstrap(): Promise<HostBootstrap>;
  loadTranscript(sessionId: string, cursor?: string): Promise<import("./host-protocol.js").TranscriptPage>;
  sendPrompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<import("./host-protocol.js").HostActionResult>;
  switchSession(path: string): Promise<import("./host-protocol.js").HostActionResult>;
  setModel(provider: string, id: string): Promise<import("./host-protocol.js").HostActionResult>;
  setThinkingLevel(level: string): Promise<import("./host-protocol.js").HostActionResult>;
  compactContext(): Promise<import("./host-protocol.js").HostActionResult>;
  setAccessLevel(level: AccessLevel): Promise<void>;
  resolveToolApproval(id: string, allowed: boolean): Promise<void>;
  chooseWorkspace(): Promise<HostActionResult | undefined>;
  openProject(path: string): Promise<HostActionResult>;
  cloneProject(repositoryUrl: string): Promise<HostActionResult | undefined>;
  generateThreadTitle(provider: string, modelId: string, force?: boolean): Promise<import("./host-protocol.js").HostActionResult>;
  getFileTree(path?: string): Promise<FileNode[]>;
  getChanges(): Promise<UiWorkspaceChanges>;
  getFileDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  commit(message: string, push: boolean): Promise<CommitResult>;
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  createWorktree(branch: string): Promise<HostActionResult>;
  switchRef(ref: string): Promise<HostActionResult>;
  listEditors(): Promise<UiEditor[]>;
  openInEditor(editorId: string, path?: string): Promise<void>;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
}

declare global {
  interface Window {
    tau?: TauDesktopApi;
  }
}
