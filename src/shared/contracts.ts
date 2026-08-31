import type { HostActionResult } from "./host-protocol.js";
import type { TranscriptBundle } from "./transcript-contract.js";
import type { HostTranscriptCursor } from "./transcript-cursor.js";

declare const newThreadRequestIdBrand: unique symbol;
/** Opaque identity for one new-thread request across renderer, host, and bridge. */
export type NewThreadRequestId = string & { readonly [newThreadRequestIdBrand]: true };
export function createNewThreadRequestId(value: string): NewThreadRequestId {
  return value as NewThreadRequestId;
}

export type UiRole = "user" | "assistant" | "notice";

export interface UiMessageImage {
  mimeType: string;
  /** Raw base64 image payload persisted by Pi. */
  data: string;
}

/** Skill dialect selected by the runtime adapter, never inferred from a model id. */
export type SkillInvocationDialect = "pi" | "claude-code";

/** The owner of a thread's lifecycle and transcript. This is not a model provider. */
export type ThreadBackendKind = "pi" | "claude-code";

/** Capabilities supplied by the runtime owner at the host/adapter boundary. */
export interface RuntimeCapabilities {
  skillInvocationDialect: SkillInvocationDialect;
}

/** Host-resolved metadata for a user skill invocation. */
export interface UiSkillInvocation {
  name: string;
  /** Runtime-adapter-supported command spelling, without the user instruction. */
  command: string;
  /** Compact text safe to copy back into this runtime. */
  copyText: string;
}

export interface UiMessage {
  id: string;
  /** Persisted Pi session entry used for exact branch/fork operations. */
  sourceEntryId?: string;
  /** Stable renderer-to-runtime correlation id for this user turn. */
  clientMessageId?: string;
  role: UiRole;
  text: string;
  /** Present only when the host recognized a known skill invocation. */
  skill?: UiSkillInvocation;
  thinking?: string;
  images?: readonly UiMessageImage[];
  timestamp: number;
}

/** Bounded image payload selected in the desktop composer. Data is raw base64. */
export interface UiImagePreview {
  name: string;
  dataUrl: string;
}

export interface UiPromptAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

export interface UiTask {
  id: number;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy?: number[];
}

export interface UiTaskProgress {
  tasks: UiTask[];
  completed: number;
  total: number;
}

export interface UiTaskProgressEntry {
  id: string;
  anchorMessageId?: string;
  progress: UiTaskProgress;
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

export interface UiComposerCommand {
  /** Invocation without the leading slash, for example `review` or `skill:tdd`. */
  name: string;
  description?: string;
  argumentHint?: string;
  source: "extension" | "prompt" | "skill";
  /** Host/runtime-resolved command spelling for a selectable skill. */
  skillCommand?: string;
}

/** Structured renderer-to-host skill selection; no runtime wrapper crosses IPC. */
export interface UiSkillDraft {
  /** The composer can submit only a catalogued skill, never an extension/prompt command. */
  source: "skill";
  name: string;
  visibleText: string;
  /** Already resolved by the selected runtime adapter; the renderer never derives it. */
  command: string;
}

/** Opaque host-prepared prompt data returned before an optimistic render. */
export interface PreparedPrompt {
  /** Canonical Tau thread owner. Undefined means a new thread. */
  tauThreadId?: string;
  /** Provider-owned session id, when the selected backend has one. */
  providerSessionId?: string;
  /** @deprecated v1 wire alias for the Tau thread id; never a provider id. */
  sessionId?: string;
  backendKind: ThreadBackendKind;
  runtimeCapabilities: RuntimeCapabilities;
  /** Text safe to render in the timeline; line whitespace is preserved. */
  visibleText: string;
  /** Runtime-owned text. Renderer passes this back as an opaque value. */
  runtimeText: string;
  skill?: UiSkillInvocation;
  /** Prevents a prepared result from being replayed for another input. */
  sourceFingerprint: string;
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
  /** Lifecycle owner; older index entries default to Pi. */
  backendKind?: ThreadBackendKind;
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

/**
 * Pi has no service-tier concept either; Tau maps "fast" onto the provider's own
 * priority tier through the before_provider_request hook, where the API has one.
 */
export type ServiceTier = "standard" | "fast";

export type ExtensionUiPromptKind = "select" | "confirm" | "input" | "editor";

export interface UiQuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

/** The whole questionnaire a prompt belongs to, so the workbench can page through it. */
export interface UiQuestionnaire {
  /** Position of this prompt's question. */
  index: number;
  questions: UiQuestionnaireQuestion[];
}

/**
 * A blocking question an extension asked through Pi's UI context. It belongs to
 * one thread: that thread is stalled until it is answered, others are not.
 */
export interface ExtensionUiPrompt {
  id: string;
  sessionId: string;
  kind: ExtensionUiPromptKind;
  title: string;
  /** confirm only. */
  message?: string;
  /** select only. */
  options?: string[];
  /** input only. */
  placeholder?: string;
  /** editor only. */
  prefill?: string;
  /** Wall-clock deadline when the extension passed a timeout. */
  expiresAt?: number;
  /** The question is answered outside Tau — Pi owns the runtime and asks in its terminal. */
  answerElsewhere?: boolean;
  questionnaire?: UiQuestionnaire;
}

export type ExtensionUiAnswer =
  | { cancelled: true }
  /** `typed` marks free text entered for a select, as opposed to a clicked choice. */
  | { value: string; typed?: boolean }
  | { confirmed: boolean };

export interface ToolApprovalRequest {
  id: string;
  /** The thread whose run is blocked on this decision. */
  sessionId: string;
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
  /** Why a historical diff cannot be opened for this entry, when applicable. */
  note?: string;
}

export type WorkspaceChangesCompleteness = "complete" | "partial";

export interface UiWorkspaceChanges {
  branch?: string;
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

/**
 * Immutable workspace summary captured when one accepted user turn reaches its
 * final assistant boundary. The id is generated once for that client turn and
 * is reused as the durable identity after reload.
 */
export interface UiTurnCheckpoint extends UiWorkspaceChanges {
  id: string;
  turnId: string;
  sessionId: string;
  /** Persisted message-entry id used to place the card below the answer. */
  anchorMessageId: string;
  /** Immutable Git tree/ref captured immediately before this turn. */
  beforeSnapshotId: string;
  /** Immutable Git tree/ref captured when this turn settled. */
  afterSnapshotId: string;
  startedAt: number;
  endedAt: number;
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

export interface PushResult {
  detail: string;
}

export interface ShellActionResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

export interface UiTurnActivity {
  tools: UiToolRun[];
  /** Last visible message rendered before the first tool call in this turn. */
  anchorMessageId?: string;
}

/**
 * Historical activity for one user turn.  The host keeps this separate from
 * the live activity payload so a bounded transcript can render each turn at
 * its own anchor without replaying the entire raw Pi branch in the renderer.
 */
export interface UiTurnActivityEntry extends UiTurnActivity {
  /** Stable id derived from the owning turn and safe to use as a React key. */
  id: string;
  /** Result of the activity group as a whole, not just its newest tool call. */
  status: "running" | "completed" | "interrupted" | "error";
}

export interface HostSnapshot extends TranscriptBundle<UiMessage, HostTranscriptCursor> {
  cwd: string;
  /** Canonical Tau thread owner. `sessionId` remains for v1 renderer clients. */
  threadId?: string;
  /** Provider-owned runtime session id; it is not used for Tau indexing. */
  providerSessionId?: string;
  /** @deprecated v1 alias for the Tau thread id. */
  sessionId: string;
  branch?: string;
  sessionName?: string;
  sessionTitle: string;
  model?: UiModel;
  /** Dialect supplied by the selected runtime adapter, never by model.provider. */
  runtimeCapabilities?: RuntimeCapabilities;
  backendKind?: ThreadBackendKind;
  models: UiModel[];
  thinkingLevel: string;
  thinkingLevels: string[];
  /** Cursor for the next page when this snapshot already contains a bounded window. */
  isStreaming: boolean;
  activeTools: string[];
  turnActivity?: UiTurnActivity;
  turnCheckpoints?: UiTurnCheckpoint[];
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
  allTools: Array<{ name: string; description: string }>;
  composerCommands?: UiComposerCommand[];
  extensionCount: number;
  contextUsage?: UiContextUsage;
  serviceTier: ServiceTier;
  /** False when the active model's API has no priority tier to ask for. */
  serviceTierAvailable: boolean;
  /** Whether the active host/runtime adapter accepts image prompt input. */
  /** Optional for protocol-v1 compatibility; missing means unsupported. */
  supportsImageInput?: boolean;
}

/** Capability of the runtime prepared for a not-yet-created thread. */
export interface PreparedThreadCapability {
  cwd: string;
  generation: number;
  /** Optional for protocol-v1 compatibility; missing means unsupported. */
  supportsImageInput?: boolean;
}

export interface ThreadIndexSnapshot {
  projects: UiProject[];
  sessions: UiSession[];
}

export interface HostBootstrapDetail extends TranscriptBundle<UiMessage, HostTranscriptCursor> {
  /** Canonical Tau thread owner; sessionId remains the v1 wire alias. */
  threadId?: string;
  /** Provider-owned runtime session id, when available. */
  providerSessionId?: string;
  sessionId: string;
  /** Runtime lifecycle owner; omitted by older peers. */
  backendKind?: ThreadBackendKind;
  isStreaming: boolean;
  activeTools: string[];
  turnActivity?: UiTurnActivity;
  turnCheckpoints?: UiTurnCheckpoint[];
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
  contextUsage?: UiContextUsage;
  /** Older v1 clients may omit this derived flag. */
  hasMore?: boolean;
}

export interface HostBootstrap {
  threadIndex: ThreadIndexSnapshot;
  version: 1;
  detail: HostBootstrapDetail;
  catalog: {
    sessionId?: string;
    /** Lifecycle owner for the active thread; old bootstrap payloads omit it. */
    backendKind?: ThreadBackendKind;
    models: UiModel[];
    model?: UiModel;
    runtimeCapabilities?: RuntimeCapabilities;
    thinkingLevel: string;
    thinkingLevels: string[];
    serviceTier: ServiceTier;
    serviceTierAvailable: boolean;
    allTools: Array<{ name: string; description: string }>;
    composerCommands?: UiComposerCommand[];
    extensionCount: number;
    /** Optional for protocol-v1 compatibility; missing means unsupported. */
    supportsImageInput?: boolean;
  };
  project: { cwd: string; branch?: string };
}

export type GlobalHostEvent =
  | { type: "host-update"; update: import("./host-protocol.js").HostUpdate }
  | { type: "thread-index"; threadIndex: ThreadIndexSnapshot }
  | { type: "error"; message: string; sessionId?: undefined }
  | { type: "event-log"; label: string; detail?: string; timestamp: number; sessionId?: undefined };

/** Events emitted by a runtime always carry the owning session explicitly. */
export type ThreadHostEvent =
  | { type: "agent-status"; sessionId: string; running: boolean }
  | { type: "turn-checkpoint"; sessionId: string; checkpoint: UiTurnCheckpoint }
  | {
      type: "turn-checkpoint-status";
      sessionId: string;
      turnId: string;
      status: "queued" | "waiting" | "capturing" | "persisting" | "ready" | "failed";
    }
  /** Adds the persisted session-entry id to a row emitted optimistically at message_end. */
  | {
      type: "assistant-anchor";
      sessionId: string;
      id: string;
      sourceEntryId: string;
      timestamp: number;
      /** Next transcript-visible row in branch order, when one is loaded. */
      beforeMessageId?: string;
    }
  // Every thread has its own runtime, so live events name the thread they belong
  // to; the renderer applies them only to the thread it is showing.
  | { type: "assistant-start"; sessionId: string; id: string; timestamp: number }
  | { type: "assistant-delta"; sessionId: string; id: string; delta: string }
  | { type: "assistant-thinking"; sessionId: string; id: string; delta: string }
  | { type: "assistant-end"; sessionId: string; message: UiMessage }
  | { type: "user-message"; sessionId: string; message: UiMessage }
  | { type: "user-message-failed"; sessionId: string; clientMessageId: string; message: string }
  | { type: "tool-start"; sessionId: string; tool: UiToolRun }
  | { type: "tool-update"; sessionId: string; id: string; output: string }
  | { type: "tool-end"; sessionId: string; tool: UiToolRun }
  | { type: "queue"; sessionId: string; steering: string[]; followUp: string[] }
  | { type: "tool-approval"; sessionId: string; request: ToolApprovalRequest }
  | { type: "extension-ui-prompt"; sessionId: string; prompt: ExtensionUiPrompt }
  | { type: "extension-ui-resolved"; id: string; sessionId: string }
  | { type: "notice"; message: string; level: "info" | "warning" | "error"; sessionId: string }
  | { type: "error"; message: string; sessionId: string }
  | { type: "event-log"; label: string; detail?: string; timestamp: number; sessionId: string };

export type HostEvent = GlobalHostEvent | ThreadHostEvent;

/** The single result shape used by host, scoped composer store, and renderer. */
export type SubmissionResult =
  | { accepted: true }
  | { accepted: false; message: string };

/** A desktop extension compiled by the host, ready for the renderer to import. */
export interface DesktopExtensionBundle {
  path: string;
  scope: "global" | "project";
  projectPath?: string;
  /** Self-contained ES module; shared libraries come from `globalThis.__tauShared`. */
  code: string;
}

export interface DesktopExtensionLoadResult {
  bundles: DesktopExtensionBundle[];
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

export interface WorkbenchBuildResult {
  ok: boolean;
  durationMs: number;
  /** The main process or preload changed; only a restart applies that. */
  mainChanged: boolean;
  /** Last lines of the build output. */
  output: string;
}

export interface UiDirectoryListing {
  path: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
}

export interface TauDesktopApi {
  /** Host platform, so the title bar can leave room for native window controls. */
  readonly platform: string;
  bootstrap(): Promise<HostBootstrap>;
  loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<import("./host-protocol.js").TranscriptPage>;
  preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft): Promise<PreparedPrompt>;
  /** Prompts, steering and aborts target one thread; without an id they go to the thread on screen. */
  sendPrompt(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageId?: string, prepared?: PreparedPrompt): Promise<void>;
  runShellAction(command: string, includeInContext?: boolean, expectedCwd?: string): Promise<ShellActionResult>;
  steer(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageId?: string, prepared?: PreparedPrompt): Promise<void>;
  followUp(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageId?: string, prepared?: PreparedPrompt): Promise<void>;
  abort(sessionId?: string): Promise<void>;
  /** Creates the thread in `cwd` directly; the project does not have to be opened first. */
  newSession(initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, clientMessageIdOrRequestId?: string, prepared?: PreparedPrompt): Promise<import("./host-protocol.js").NewThreadResult>;
  getPreparedThreadCapability(cwd?: string): Promise<PreparedThreadCapability>;
  forkThread(entryId: string, expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  switchSession(path: string): Promise<import("./host-protocol.js").HostActionResult>;
  setModel(provider: string, id: string): Promise<import("./host-protocol.js").HostActionResult>;
  setThinkingLevel(level: string): Promise<import("./host-protocol.js").HostActionResult>;
  compactContext(): Promise<import("./host-protocol.js").HostActionResult>;
  recoverThread(): Promise<import("./host-protocol.js").HostActionResult>;
  /** Reload Pi resources first; the renderer then reloads its desktop extensions. */
  reloadRuntime(): Promise<void>;
  setServiceTier(tier: ServiceTier): Promise<import("./host-protocol.js").HostActionResult>;
  setAccessLevel(level: AccessLevel): Promise<{ applied: boolean; reason?: string }>;
  resolveToolApproval(id: string, allowed: boolean): Promise<void>;
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): Promise<void>;
  /** Re-announces questions raised before this renderer was listening. */
  syncExtensionUi(): Promise<void>;
  chooseWorkspace(): Promise<HostActionResult | undefined>;
  listDirectories(path?: string): Promise<UiDirectoryListing>;
  openProject(path: string): Promise<HostActionResult>;
  removeProject(path: string): Promise<HostActionResult>;
  cloneProject(repositoryUrl: string): Promise<HostActionResult | undefined>;
  renameThread(title: string, expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  copyText(text: string): Promise<void>;
  copyThreadMarkdown(expectedSessionId?: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  generateThreadTitle(provider: string, modelId: string, force?: boolean, expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  getFileTree(path?: string): Promise<FileNode[]>;
  getChanges(): Promise<UiWorkspaceChanges>;
  getFileDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  /** Loads the immutable diff captured for one completed turn. */
  getTurnFileDiff(sessionId: string, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  /** Loads one bounded page of files from an immutable turn snapshot pair. */
  getTurnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  commit(message: string, push: boolean): Promise<CommitResult>;
  push(): Promise<PushResult>;
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  createWorktree(branch: string, baseRef?: string): Promise<HostActionResult>;
  switchRef(ref: string): Promise<HostActionResult>;
  listEditors(): Promise<UiEditor[]>;
  openInEditor(editorId: string, path?: string): Promise<void>;
  /**
   * Compiles the desktop extensions for a workspace. `sharedExports` names what the
   * renderer publishes on `globalThis.__tauShared`, so bundles can bind to it.
   */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>): Promise<DesktopExtensionLoadResult>;
  /** Rebuilds the workbench from source without leaving the app. */
  rebuildWorkbench(): Promise<WorkbenchBuildResult>;
  /** Restarts the app so a rebuilt main process takes effect. */
  relaunchWorkbench(): Promise<void>;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
}

declare global {
  interface Window {
    tau?: TauDesktopApi;
  }
}
