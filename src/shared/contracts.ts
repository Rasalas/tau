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
/** How a runtime spells a skill command: Pi as `/skill:name`, any other runtime as `/name`. */
export type SkillInvocationDialect = "pi" | (string & {});

/** The owner of a thread's lifecycle and transcript. This is not a model provider. */
/** Which runtime owns a thread: Pi in process, or a backend a host extension registered. */
export type ThreadBackendKind = "pi" | (string & {});

/** Capabilities supplied by the runtime owner at the host/adapter boundary. */
export interface RuntimeCapabilities {
  skillInvocationDialect: SkillInvocationDialect;
  /** The runtime picks model and reasoning itself; the composer offers no pickers. */
  ownsModelSelection?: boolean;
  /** False when the runtime cannot stop for an approval; the access gate then offers no "ask". */
  interactiveApprovals?: boolean;
}

/** Host-resolved metadata for a user skill invocation. */
export interface UiSkillInvocation {
  name: string;
  /** Runtime-adapter-supported command spelling, without the user instruction. */
  command: string;
  /** Compact text safe to copy back into this runtime. */
  copyText: string;
}

/**
 * Correlates one renderer submission with the user message Pi eventually
 * writes. Pi may expand a skill or prompt template before that message is
 * emitted, so the correlation must not depend on the submitted text.
 */
export interface ClientTurnIdentity {
  clientTurnId: string;
  clientMessageId: string;
  /** Correlates a detached first prompt with its prepared new-thread draft. */
  newThreadRequestId?: NewThreadRequestId;
}

export interface UiMessage {
  id: string;
  /** Persisted Pi session entry used for exact branch/fork operations. */
  sourceEntryId?: string;
  /** Stable renderer-to-runtime correlation id for this user turn. */
  clientTurnId?: string;
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
  /** The visible output is a preview of a durable result. */
  outputTruncated?: boolean;
  /** A deliberate host read can retrieve the complete durable result. */
  fullOutputAvailable?: boolean;
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
  /** Short label an extension gives the project, e.g. its Git branch. */
  projectLabel?: string;
  messageCount: number;
  /** Lifecycle owner; older index entries default to Pi. */
  backendKind?: ThreadBackendKind;
}

export interface UiProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}


/** Context window usage for the active thread, as reported by the Pi session. */
export interface UiContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export type ExtensionUiPromptKind = "select" | "confirm" | "input" | "editor";

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
  /** What host extensions attached for their desktop halves, keyed by extension id. */
  extras?: Record<string, unknown>;
}

export type ExtensionUiAnswer =
  | { cancelled: true }
  /** `typed` marks free text entered for a select, as opposed to a clicked choice. */
  | { value: string; typed?: boolean }
  | { confirmed: boolean };

export interface ShellActionResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

/** Result of a deliberate, bounded read of a persisted tool result. */
export interface UiToolOutputReadResult {
  toolCallId: string;
  output: string;
  totalBytes: number;
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
  /** Short label an extension gives the project, e.g. its Git branch. */
  projectLabel?: string;
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
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
  allTools: Array<{ name: string; description: string }>;
  composerCommands?: UiComposerCommand[];
  extensionCount: number;
  contextUsage?: UiContextUsage;
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
    allTools: Array<{ name: string; description: string }>;
    composerCommands?: UiComposerCommand[];
    extensionCount: number;
    /** Optional for protocol-v1 compatibility; missing means unsupported. */
    supportsImageInput?: boolean;
  };
  project: { cwd: string; label?: string };
}

export type GlobalHostEvent =
  | { type: "host-update"; update: import("./host-protocol.js").HostUpdate }
  | { type: "thread-index"; threadIndex: ThreadIndexSnapshot }
  /** Published by a host extension for its desktop counterpart; core only routes it. */
  | { type: "extension-event"; extensionId: string; name: string; payload?: unknown; sessionId?: undefined }
  | { type: "error"; message: string; sessionId?: undefined }
  | { type: "event-log"; label: string; detail?: string; timestamp: number; sessionId?: undefined };

/** Events emitted by a runtime always carry the owning session explicitly. */
export type ThreadHostEvent =
  | { type: "agent-status"; sessionId: string; running: boolean }
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
  /**
   * The prompt was accepted but answered without a user turn, so no user
   * message will ever persist for it. Extension commands work this way.
   */
  | { type: "prompt-without-user-turn"; sessionId: string; clientMessageId: string }
  /**
   * Detached new-thread delivery reached its authoritative outcome. This is the
   * commit point for a draft: session allocation happens earlier and the agent
   * run ends later.
   */
  | { type: "new-thread-delivery-settled"; sessionId: string; clientMessageId: string; accepted: true }
  | { type: "new-thread-delivery-settled"; sessionId: string; clientMessageId: string; accepted: false; message: string }
  | { type: "user-message-failed"; sessionId: string; clientMessageId: string; message: string }
  | { type: "tool-start"; sessionId: string; tool: UiToolRun }
  | { type: "tool-update"; sessionId: string; id: string; output: string }
  | { type: "tool-end"; sessionId: string; tool: UiToolRun }
  | { type: "queue"; sessionId: string; steering: string[]; followUp: string[] }
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

/** What the host reports about one of its extensions, for settings and diagnostics. */
export interface HostExtensionSummary {
  id: string;
  name: string;
  active: boolean;
  commands: string[];
  /** Activation failure, when the extension is known but could not start. */
  error?: string;
}

/** One package folder as the settings inspector lists it; no code is loaded for this. */
export interface ExtensionPackageSummary {
  id: string;
  name: string;
  version?: string;
  engines?: Record<string, string>;
  permissions?: string[];
  granted?: boolean;
  source?: { url: string; commit?: string };
  scope: "global" | "project";
  directory: string;
  desktop: boolean;
  host: boolean;
}

export interface ExtensionInspection {
  /** What a package's `engines` is checked against. */
  versions: { tau: string; pi: string; api: string };
  directories: Array<{ scope: "global" | "project"; directory: string }>;
  packages: ExtensionPackageSummary[];
  errors: Array<{ path: string; message: string }>;
  skipped: Array<{ directory: string; reason: string }>;
}

/** A desktop extension compiled by the host, ready for the renderer to import. */
export interface DesktopExtensionBundle {
  path: string;
  scope: "global" | "project";
  projectPath?: string;
  /** Self-contained ES module; shared libraries come from `globalThis.__tauShared`. */
  code: string;
  permissions: readonly string[];
  granted?: boolean;
  source?: { url: string; commit?: string };
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

/** One entry of a thread's session tree, flattened in preorder for display. */
export interface UiThreadTreeNode {
  id: string;
  parentId?: string;
  depth: number;
  kind: "user" | "assistant" | "summary";
  /** First line of the message or summary, bounded. */
  text: string;
  label?: string;
  timestamp: number;
  /** On the path the thread currently continues from. */
  onBranch: boolean;
  isLeaf: boolean;
  /** A user message the thread can be forked through. */
  forkable: boolean;
}

export interface UiThreadTree {
  sessionId: string;
  leafId?: string;
  nodes: UiThreadTreeNode[];
}

export interface ThreadTreeNavigationResult extends HostActionResult {
  cancelled: boolean;
  /** The user message at the target, offered as the next draft the way Pi's /tree does. */
  draftText?: string;
}

export interface TauDesktopApi {
  /** Host platform, so the title bar can leave room for native window controls. */
  readonly platform: string;
  bootstrap(): Promise<HostBootstrap>;
  loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<import("./host-protocol.js").TranscriptPage>;
  preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft): Promise<PreparedPrompt>;
  /** Prompts, steering and aborts target one thread; without an id they go to the thread on screen. */
  sendPrompt(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  runShellAction(command: string, includeInContext?: boolean, expectedCwd?: string): Promise<ShellActionResult>;
  steer(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  followUp(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  abort(sessionId?: string): Promise<void>;
  /** Creates the thread in `cwd` directly; the project does not have to be opened first. */
  newSession(initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, clientMessageIdOrRequestId?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<import("./host-protocol.js").NewThreadResult>;
  getPreparedThreadCapability(cwd?: string): Promise<PreparedThreadCapability>;
  forkThread(entryId: string, expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  /** Pi's /tree: the session tree, moving the thread to another point in it, and /clone. */
  threadTree(sessionId?: string): Promise<UiThreadTree>;
  navigateThreadTree(entryId: string, options?: { summarize?: boolean }, expectedSessionId?: string): Promise<ThreadTreeNavigationResult>;
  duplicateThread(expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  switchSession(path: string): Promise<import("./host-protocol.js").HostActionResult>;
  setModel(provider: string, id: string): Promise<import("./host-protocol.js").HostActionResult>;
  setThinkingLevel(level: string): Promise<import("./host-protocol.js").HostActionResult>;
  compactContext(): Promise<import("./host-protocol.js").HostActionResult>;
  recoverThread(): Promise<import("./host-protocol.js").HostActionResult>;
  /** Reload Pi resources first; the renderer then reloads its desktop extensions. */
  reloadRuntime(): Promise<void>;
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): Promise<void>;
  /** Re-announces questions raised before this renderer was listening. */
  syncExtensionUi(): Promise<void>;
  openProject(path: string): Promise<HostActionResult>;
  removeProject(path: string): Promise<HostActionResult>;
  renameThread(title: string, expectedSessionId?: string): Promise<import("./host-protocol.js").HostActionResult>;
  copyText(text: string): Promise<void>;
  /** Copies a validated image data URL through the Electron main process. */
  copyImage(dataUrl: string): Promise<void>;
  /** Reads the persisted tool result, rather than the bounded transcript preview. */
  readToolOutput(sessionId: string, toolCallId: string): Promise<UiToolOutputReadResult | undefined>;
  copyThreadMarkdown(expectedSessionId?: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  /**
   * Compiles the desktop extensions for a workspace. `sharedExports` names what the
   * renderer publishes on `globalThis.__tauShared`, so bundles can bind to it.
   */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>): Promise<DesktopExtensionLoadResult>;
  /**
   * Invokes a command a host extension registered. Host features that are not
   * part of the core (Git, files, editors, ...) live behind this one channel.
   */
  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  listHostExtensions(): Promise<HostExtensionSummary[]>;
  /** Scans the package folders a workspace sees, for the settings inspector. */
  inspectExtensions(cwd: string): Promise<ExtensionInspection>;
  /** Turns the host half of an extension package off or on; bundled kits stay as they are. */
  setHostExtensionActive(id: string, active: boolean): Promise<HostExtensionSummary[]>;
  /** Grants or revokes permissions for an extension package. */
  grantExtension(id: string, grant: boolean): Promise<void>;
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
