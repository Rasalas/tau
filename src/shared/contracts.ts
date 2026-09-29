import type { HostActionResult } from "./host-protocol.js";
import type { HostPush, HostResponse } from "./host-transport.js";
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
  /** The runtime takes `kind: "file"` prompt attachments; without it the host refuses them. */
  fileAttachments?: boolean;
  /** Interaction modes besides `default` a thread of this runtime can run its turns in, e.g. `plan`. */
  modes?: readonly string[];
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
  /** True when the entry was executed locally and excluded from model context (e.g. !! command). */
  excludedFromContext?: boolean;
  /** Why the runtime stopped this answer, in the provider's words; the answer's text may be empty. */
  error?: string;
  /** Set on a `notice` row that marks a context compaction; the transcript draws a divider. New in API 1.27.0. */
  compaction?: UiCompaction;
}

/** What a context compaction did, as far as the runtime knows it. */
export interface UiCompaction {
  /** Context size before and after, in tokens; `tokensAfter` may be an estimate. */
  tokensBefore?: number;
  tokensAfter?: number;
  /** The 1-based user turns the summary replaced. */
  turns?: { first: number; last: number };
  /** The summary the runtime continues from, Markdown. */
  summary?: string;
}

/** Bounded image payload selected in the desktop composer. Data is raw base64. */
export interface UiImagePreview {
  name: string;
  dataUrl: string;
}

/** A workspace file the page may load by URL: a PDF in a frame, an image, audio, video. */
export interface UiSharedFile {
  /** `tau-ext://files/<token>/<name>`, served by the window's own process. */
  url: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface UiPromptImageAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

/**
 * A file already on the host's disk. Only a runtime whose adapter declares
 * `fileAttachments` takes one; for any other the client embeds it as text.
 */
export interface UiPromptFileAttachment {
  kind: "file";
  name: string;
  mimeType: string;
  /** Absolute path on the host. */
  path: string;
  size: number;
}

export type UiPromptAttachment = UiPromptImageAttachment | UiPromptFileAttachment;

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
  /**
   * The host held `output` back because it is large: `outputLength` characters
   * that load on request through `HostClient.toolOutput`. Only settled tools.
   */
  outputDeferred?: boolean;
  outputLength?: number;
  startedAt: number;
  endedAt?: number;
}

export interface UiModel {
  provider: string;
  id: string;
  name: string;
  /** Reached through a consumer-subscription login the runtime performs, not an API key. */
  login?: "subscription";
  /**
   * How using it is paid for, where the runtime knows. Runtime catalogs carry
   * it and the fields below; a thread's own `models` leave them out.
   */
  billing?: UiModelBilling;
  /** What the same model costs over its provider's API; a subscription offering carries it as the price it would have had. */
  price?: UiModelPrice;
  /** Tokens of context the model reads. */
  contextWindow?: number;
  /** Tokens it may write in one response. */
  maxOutput?: number;
  /** It takes images as input. */
  images?: boolean;
  /** It reasons before answering; its levels are the catalog's `thinkingLevels`. */
  reasoning?: boolean;
  /** When the model came out, `YYYY-MM-DD` (or `YYYY-MM`), where models.dev knows it. */
  releasedAt?: string;
}

/** A subscription login, an API key, a free offering, or a model on the user's own machine. */
export type UiModelBilling = "subscription" | "api-key" | "free" | "local";

/** US dollars per million tokens. */
export interface UiModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A runtime backend a new thread can be created on; Pi is always one of them. */
export interface UiRuntimeBackend {
  kind: ThreadBackendKind;
  label: string;
  /** Interaction modes besides `default` a new thread of this backend offers. */
  modes?: string[];
  /** Model providers the runtime owns; beside one of them its mark stands alone (API 1.24.0). */
  homeProviders?: string[];
  /** A subscription on this runtime is its own plan, not the model provider's (API 1.24.0). */
  ownPlan?: boolean;
  /** The program the backend drives, once the host asked it; see `RuntimeToolVersion`. */
  version?: RuntimeToolVersion;
}

/** What a backend knows of the program it drives, so a client can say an update is out. */
export interface RuntimeToolVersion {
  /** The program as the user knows it: `codex`, `claude`. */
  tool: string;
  installed?: string;
  /** The newest release; absent when it is unknown. */
  latest?: string;
  /** What updates it: a shell command, or where in Tau to click. */
  updateCommand?: string;
  /** How well Tau works with `installed`, when the backend keeps a policy for it. */
  compatibility?: RuntimeCompatibility;
}

/**
 * Where an installed version falls in a backend's policy: `supported`, `unsafe`
 * (it runs, with known problems) or `broken` (threads refuse to start).
 */
export interface RuntimeCompatibility {
  status: "supported" | "unsafe" | "broken";
  /** Why, in a sentence. */
  message?: string;
  /** The release Tau was tested against. */
  recommendedVersion?: string;
  /** The shell command that installs `recommendedVersion`; the user runs it, never Tau. */
  installCommand?: string;
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

/** Tokens and money a thread has used so far, summed over its assistant messages. */
export interface UiThreadUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Money billed per token. What a subscription paid for is never in here; see `subscription`. */
  costUsd: number;
  turns: number;
  /** The share a subscription paid for; its tokens and turns are counted above as well. New in API 1.12.0. */
  subscription?: UiSubscriptionUsage;
}

/** Usage a subscription covered: nobody was charged per token for it. */
export interface UiSubscriptionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  turns: number;
  /** What the same tokens would have cost over the provider's API; 0 when no price is known. */
  apiValueUsd: number;
}

/** A message waiting for its thread's turn to end, as the thread list shows it. */
export interface UiQueuedMessage {
  id: string;
  text: string;
  /** Images and files that travel with it. */
  attachments: number;
  /** The thread that sent it, when another thread's agent did. */
  fromThreadId?: string;
}

/** A queued message in full, as `take-queued` hands it back to a composer. */
export interface UiQueuedPrompt {
  id: string;
  text: string;
  attachments: UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
}

/** A thread its provider stopped at a usage or rate limit. */
export interface UiThreadLimit {
  /** What the provider said. */
  message: string;
  /** When the limit resets (epoch ms), when the provider said so. */
  resetsAt?: number;
  /** When the host continues the thread by itself; absent until the user asks for it. */
  resumeAt?: number;
}

export interface UiSession {
  id: string;
  path: string;
  title: string;
  modifiedAt: number;
  /** When the thread began, where the runtime's store says (API 1.11.0); absent otherwise. */
  createdAt?: number;
  /** @deprecated Display only; address the project with `workspaceId`. */
  projectPath: string;
  /** Opaque identity of the thread's project on its host. */
  workspaceId?: string;
  /** What the user sees for the project; on a local host its absolute path. */
  projectDisplayPath?: string;
  projectName: string;
  /** Short label an extension gives the project, e.g. its Git branch. */
  projectLabel?: string;
  messageCount: number;
  /** Lifecycle owner; older index entries default to Pi. */
  backendKind?: ThreadBackendKind;
  /** Provider of the thread's selected model, when the host has observed it. */
  modelProvider?: string;
  /** Id of that model, where the runtime or its session file names it (API 1.23.0). */
  model?: string;
  /** Tokens and money the thread has used; absent until the host knows them. */
  usage?: UiThreadUsage;
  /** A turn of this thread was cut short by a restart and was not continued. */
  interrupted?: boolean;
  /** Why the thread's last turn failed; the host drops it at the next prompt. */
  turnError?: string;
  /** The provider stopped the last turn at a usage or rate limit; the next prompt clears it. */
  limit?: UiThreadLimit;
  /** Messages waiting for this thread's turn to end, oldest first; the host keeps them across restarts. */
  queued?: UiQueuedMessage[];
  /** The queue waits for the user: a restart, a stop or a limit held it. */
  queueHeld?: boolean;
  /** Why the thread's runtime could not start; the thread shows read-only until it does. */
  runtimeError?: string;
  /**
   * The thread that spawned this one, as its own session file records it
   * (ADR 0013, amended). Absent for a thread the user started.
   */
  parentThreadId?: string;
  /** The machine and thread an imported session came from, as its file records it. */
  origin?: UiThreadOrigin;
}

/** Where a thread taken over from another machine came from (`sessions.import`). */
export interface UiThreadOrigin {
  /** The id of the host it ran on. */
  hostId: string;
  /** Its thread id on that host. */
  threadId: string;
}

export interface UiProject {
  /** @deprecated Display only; address the project with `workspaceId`. */
  path: string;
  /** Opaque identity of this workspace on its host. */
  workspaceId?: string;
  /** What the user sees; on a local host the absolute path. */
  displayPath?: string;
  name: string;
  lastOpenedAt: number;
  /** Project image encoded by the host so renderer clients never receive a local asset path. */
  icon?: string;
}


/** Context window usage for the active thread, as its runtime reports it. */
export interface UiContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
  /** When the runtime measured it, in ms since the epoch: the end of the turn it describes. */
  updatedAt?: number;
  /** How long the provider keeps this context in its prompt cache; absent when the runtime does not say. */
  promptCacheTtlMs?: number;
}

export type ExtensionUiPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

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
  /** custom only: pre-rendered lines or component output. */
  lines?: string[];
  /** Wall-clock deadline when the extension passed a timeout. */
  expiresAt?: number;
  /** The question is answered outside Tau — Pi owns the runtime and asks in its terminal. */
  answerElsewhere?: boolean;
  /** What host extensions attached for their desktop halves, keyed by extension id. */
  extras?: Record<string, unknown>;
}

export type ExtensionUiAnswer =
  | { cancelled: true }
  /**
   * `typed` marks free text entered for a select, as opposed to a clicked choice.
   * `attachments` travel with typed text; the host names them by path in `value`.
   */
  | { value: string; typed?: boolean; attachments?: UiPromptAttachment[] }
  | { confirmed: boolean }
  | { customResult?: unknown };

export interface ShellActionResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

/** A deferred tool's output as the transcript would have carried it. */
export interface UiToolOutputPreview {
  toolCallId: string;
  output: string;
  outputTruncated?: boolean;
  fullOutputAvailable?: boolean;
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
  /** @deprecated Display only; address the workspace with `workspaceId`. */
  cwd: string;
  /** Opaque identity of the active workspace on its host. */
  workspaceId?: string;
  /** What the user sees for the active workspace. */
  displayPath?: string;
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
  /** Backends a new thread can run on, Pi first; absent for older peers. */
  runtimeBackends?: UiRuntimeBackend[];
  /** The backend a new thread gets when the client names none. */
  defaultBackendKind?: ThreadBackendKind;
  models: UiModel[];
  /** Models an extension's own small jobs can use; they run on the user's Pi configuration, not on this thread's runtime. */
  completionModels?: UiModel[];
  thinkingLevel: string;
  thinkingLevels: string[];
  /** The interaction mode the thread's next turn runs in; absent means `default`. */
  mode?: string;
  /** The modes besides `default` the thread's runtime offers; absent or empty offers none. */
  modes?: string[];
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
  usage?: UiThreadUsage;
  /** Whether the active host/runtime adapter accepts image prompt input. */
  /** Optional for protocol-v1 compatibility; missing means unsupported. */
  supportsImageInput?: boolean;
}

/** Capability of the runtime prepared for a not-yet-created thread. */
export interface NewThreadConfiguration {
  /** An explicit per-thread choice; omitted means use the runtime default. */
  model?: Pick<UiModel, "provider" | "id">;
  /** The thinking level chosen with it, one the runtime's catalog offers; omitted means its default. */
  thinkingLevel?: string;
  /** The interaction mode the thread starts in; omitted means `default`. */
  mode?: string;
}

/**
 * What a runtime offers a thread that does not exist yet, so a draft bound
 * for it chooses a model and a thinking level before its first prompt.
 */
export interface UiRuntimeCatalog {
  kind: ThreadBackendKind;
  models: UiModel[];
  /** What a new thread runs on when nobody chooses. */
  model?: UiModel;
  /** The levels each model offers, by model id; the first is the runtime's own default. */
  thinkingLevels: Record<string, string[]>;
  runtimeCapabilities?: RuntimeCapabilities;
  /** Why the models are known only once a thread runs, or why the runtime cannot run now. */
  note?: string;
  /**
   * Absent while the runtime can run a thread. `not-installed` and
   * `sign-in-required` come with no models; `unavailable` keeps the models
   * the runtime named last, if any, and `note` says what failed.
   */
  status?: UiRuntimeCatalogStatus;
  /** When the runtime named this list, in ms since the epoch; an unchanged answer keeps it. */
  checkedAt?: number;
}

export type UiRuntimeCatalogStatus = "not-installed" | "sign-in-required" | "unavailable";

export interface PreparedThreadCapability {
  cwd: string;
  generation: number;
  /** Optional for protocol-v1 compatibility; missing means unsupported. */
  supportsImageInput?: boolean;
}

export interface ThreadIndexSnapshot {
  projects: UiProject[];
  sessions: UiSession[];
  /**
   * The threads running on the host, by id, with the host's start of each run (epoch ms). Only a
   * bootstrap carries it, and then it replaces what a client knew (API 1.27.0).
   */
  runs?: Record<string, number>;
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
  usage?: UiThreadUsage;
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
    runtimeBackends?: UiRuntimeBackend[];
    defaultBackendKind?: ThreadBackendKind;
    models: UiModel[];
    completionModels?: UiModel[];
    model?: UiModel;
    runtimeCapabilities?: RuntimeCapabilities;
    thinkingLevel: string;
    thinkingLevels: string[];
    mode?: string;
    modes?: string[];
    allTools: Array<{ name: string; description: string }>;
    composerCommands?: UiComposerCommand[];
    extensionCount: number;
    /** Optional for protocol-v1 compatibility; missing means unsupported. */
    supportsImageInput?: boolean;
  };
  project: { cwd: string; workspaceId?: string; displayPath?: string; label?: string };
}

export type GlobalHostEvent =
  | { type: "host-update"; update: import("./host-protocol.js").HostUpdate }
  | { type: "thread-index"; threadIndex: ThreadIndexSnapshot }
  /**
   * Published by a host extension for its desktop counterpart; core only routes it.
   * With a `topic` it reaches only the clients that watch that topic.
   */
  | { type: "extension-event"; extensionId: string; name: string; payload?: unknown; topic?: string; sessionId?: undefined }
  /**
   * The set of installed or approved packages moved; a client re-reads its
   * desktop halves. `extensionIds` narrows that to the ones that moved, so a
   * client can swap those modules instead of every one it loaded.
   */
  | { type: "extension-packages-changed"; extensionIds?: string[]; buildErrors?: PackageBuildError[]; sessionId?: undefined }
  /**
   * A file the host watches moved on disk: `kind` names the group it belongs to
   * ("config", "themes", "keybindings"), `paths` what changed. A client re-reads
   * whatever it holds from that group; the host re-reads nothing for it.
   */
  | { type: "config-changed"; kind: string; paths: string[]; sessionId?: undefined }
  /** A host extension the registry had to stop, with the reason to show the user. */
  | { type: "extension-deactivated"; extensionId: string; name: string; reason: string; sessionId?: undefined }
  | { type: "error"; message: string; sessionId?: undefined }
  /** How many clients are attached to this host, after one arrived or left. */
  | { type: "client-count"; count: number; sessionId?: undefined }
  /** A device asked to pair, or paired devices or links changed; only an owner can ask what (ADR 0024). */
  | { type: "connections-changed"; sessionId?: undefined }
  /** A runtime's catalog for new threads changed; only the one that changed is sent. */
  | { type: "runtime-catalog"; catalog: UiRuntimeCatalog; sessionId?: undefined }
  /** What a Pi extension titled the window with (`ctx.ui.setTitle`); each client applies it to its own. */
  | { type: "window-title"; title: string; sessionId?: undefined }
  /** A new Tau finished downloading and installs on the next restart. */
  | { type: "app-update"; version: string; sessionId?: undefined }
  /** The host's machine: which Tau it runs and how its update stands (K103). */
  | { type: "update-status"; status: import("./host-updates.js").HostUpdateStatus; sessionId?: undefined }
  /** The window's own process to its page: the app menu, the quit shortcut, a quit waiting for an answer. */
  | { type: "window-shell"; event: import("./window-shell.js").WindowShellEvent; sessionId?: undefined }
  /** The window's own process to its page: the machines it knows and how each is doing (ADR 0025). */
  | { type: "environments"; environments: import("./environments.js").UiEnvironments; sessionId?: undefined }
  /** The window's own process to its page: a thread of another machine a tab looks in on changed there (API 1.15.0). */
  | { type: "environment-thread"; view: import("./environments.js").UiEnvironmentThreadView; sessionId?: undefined }
  | { type: "event-log"; label: string; detail?: string; timestamp: number; sessionId?: undefined };

/** Events emitted by a runtime always carry the owning session explicitly. */
export type ThreadHostEvent =
  /** `startedAt`: when the host saw this run start (epoch ms), on every `running: true` (API 1.27.0). */
  | { type: "agent-status"; sessionId: string; running: boolean; startedAt?: number }
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
  /**
   * The commands registered to only look, which a device paired Read only may
   * call; a client refuses it every other one before sending (API 1.13.0).
   */
  readCommands?: string[];
  /** Where the host half runs: a worker thread, or the host process itself. */
  isolation?: "worker" | "in-process";
  /** Activation failure, when the extension is known but could not start. */
  error?: string;
}

/** One package folder as the settings inspector lists it; no code is loaded for this. */
export interface ExtensionPackageSummary {
  id: string;
  name: string;
  version?: string;
  /** The manifest's one sentence about the package. */
  description?: string;
  /** The manifest's Lucide icon name, for a package no page or panel gives an icon. */
  icon?: string;
  engines?: Record<string, string>;
  permissions?: string[];
  /** Where the host half runs; a package that declares none runs in a worker. */
  isolation?: "worker" | "in-process";
  granted?: boolean;
  source?: { url: string; commit?: string };
  /** The source string the package was installed from, when an installer put it there. */
  installedFrom?: string;
  /** What the package's optional signature proved, and one line for the user. */
  signature?: { state: "unsigned" | "signed" | "untrusted" | "tampered"; label: string };
  /** `bundled` for a kit Tau ships; the two folder scopes for everything installed. */
  scope: "bundled" | "global" | "project";
  directory: string;
  desktop: boolean;
  host: boolean;
  /** Only a stylesheet: a theme, which runs no code and needs no grant. */
  theme?: boolean;
}

export interface ExtensionInspection {
  /** What a package's `engines` is checked against. */
  versions: { tau: string; pi: string; api: string };
  /**
   * The distribution the `bundled` packages came in — `@tau/kits` and the
   * version of the set. Absent in safe mode, which loads no kit at all.
   */
  distribution?: { name: string; version: string };
  directories: Array<{ scope: "global" | "project"; directory: string }>;
  packages: ExtensionPackageSummary[];
  /**
   * Package folders that did not load. Where the manifest could be read, the
   * package's `id`, `name` and `version`; `incompatible` when its `engines`
   * rule this Tau out.
   */
  errors: Array<{ path: string; message: string; id?: string; name?: string; version?: string; incompatible?: boolean }>;
  skipped: ExtensionSkip[];
}

/** A package folder the scan passed over, and why. */
export interface ExtensionSkip {
  directory: string;
  reason: string;
  /** The project Pi does not trust, when that is why; trusting it loads what was skipped. */
  untrustedProject?: string;
  /** The packages it held, where their manifests could be read. */
  packages?: Array<{ id: string; name: string; directory: string }>;
}

/** The last compile of one half of a package, as Settings → Packages shows it. */
export interface PackageBuild {
  /** The manifest's id; absent for a loose file. */
  id?: string;
  /** The package folder, or the loose file's own folder. */
  directory: string;
  half: "desktop" | "host";
  /** The entry file that was compiled. */
  entry: string;
  /** Epoch milliseconds. */
  at: number;
  ok: boolean;
  /** What went wrong, as one text; `diagnostics` has the pieces. */
  message?: string;
  diagnostics?: BuildDiagnostic[];
}

/** A package entry that did not compile when the host last built it: a host half, as the client never builds one. */
export interface PackageBuildError {
  path: string;
  message: string;
  diagnostics?: BuildDiagnostic[];
}

/** One error esbuild reported for an entry, with where it is when it knows. */
export interface BuildDiagnostic {
  /** Relative to the package folder when the file is inside it. */
  file?: string;
  line?: number;
  column?: number;
  text: string;
  /** The source line the error points into. */
  lineText?: string;
}

/** A desktop extension compiled by the host, ready for the renderer to import. */
export interface DesktopExtensionBundle {
  path: string;
  /** `bundled` for a kit the app ships; the two folder scopes for everything else. */
  scope: "bundled" | "global" | "project";
  projectPath?: string;
  /** Manifest id of the package, or a slug of the entry file for a loose extension. */
  id: string;
  /** Self-contained ES module; shared libraries come from `globalThis.__tauShared`. */
  code: string;
  /** `tau-ext://bundles/<id>/<hash>.js` once the host serves it; absent in the browser preview. */
  url?: string;
  /** The stylesheet the manifest names, as its source; the renderer loads it while the extension is active. */
  styles?: string;
  /** `tau-ext://bundles/<id>/<hash>.css` once the host serves it. */
  stylesUrl?: string;
  permissions: readonly string[];
  granted?: boolean;
  /** A theme: only a stylesheet, and loaded after everything else so its tokens win. */
  theme?: boolean;
  source?: { url: string; commit?: string };
  /** A digest of `code` and `styles`, for a client that keeps bundles it was sent. */
  hash?: string;
  /** The client said it holds this `hash`: `code` and `styles` were left out. */
  cached?: boolean;
}

export interface DesktopExtensionLoadResult {
  bundles: DesktopExtensionBundle[];
  /** `diagnostics` when the entry did not compile; `message` then carries them as text too. */
  errors: Array<{ path: string; message: string; diagnostics?: BuildDiagnostic[] }>;
  skipped: ExtensionSkip[];
}

export interface WorkbenchBuildResult {
  ok: boolean;
  durationMs: number;
  /** The main process or preload changed; only a restart applies that. */
  mainChanged: boolean;
  /**
   * A kit's runtime half changed. Those load inside the agent runtime, so the
   * new code needs a runtime reload; everything else reloads without one.
   */
  runtimeChanged: boolean;
  /** Last lines of the build output. */
  output: string;
}

export type WorkbenchReloadMode = "inspect" | "wait" | "abort";
export interface WorkbenchReloadPreparation {
  ready: boolean;
  runningThreads: number;
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

export interface UserTheme {
  id: string;
  name: string;
  css: string;
  base?: "dark" | "light" | "system";
  sourcePath?: string;
}

export interface TauConfigModels {
  default?: string;
  thinkingLevel?: string;
}

export interface TauCompactionConfig {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

export interface TauRetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  provider?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
  };
}

export interface TauConfigExtensions {
  /**
   * Whether the host watches the files it reads — package folders, themes,
   * keybindings, config — and reloads what changed. On unless set to false or
   * `TAU_NO_WATCH=1` is in the environment.
   */
  watch?: boolean;
}

/** Settings about threads themselves, rather than about the model they run on. */
export interface TauThreadsConfig {
  /**
   * Whether the host picks a thread back up when a restart cut its turn short.
   * Off by default: continuing costs a model call nobody asked for.
   */
  continueAfterRestart?: boolean;
}

/** How an installed Tau updates itself; read by the window's process on this machine. */
export interface TauUpdatesConfig {
  channel?: import("./app-version.js").UpdateChannel;
}

/** What the app asks before it quits; read by the window's process on this machine. */
export interface TauConfirmConfig {
  /** How ⌘Q quits: held, pressed twice, or at once. */
  quit?: import("./window-shell.js").QuitConfirmation;
  /** Ask before quitting while threads are working and the host would stop with the app. */
  quitWhileRunning?: boolean;
}

export interface TauConfig {
  theme?: "system" | "dark" | "light" | string;
  extensions?: TauConfigExtensions;
  threads?: TauThreadsConfig;
  updates?: TauUpdatesConfig;
  confirm?: TauConfirmConfig;
  transcriptDetail?: "focused" | "detailed" | "everything";
  showCosts?: boolean;
  favouriteModels?: string[];
  /** What the model picker hides and in which order it lists models, by runtime backend kind. */
  modelPreferences?: Record<string, TauModelPreferences>;
  /**
   * The user's own prices, keyed `provider/id` or a bare model id for every
   * provider. They replace the runtime's and Pi's prices in costs, in the
   * value of subscription usage and in the model picker. New in API 1.12.0.
   */
  modelPrices?: Record<string, UiModelPrice>;
  disabledExtensions?: string[];
  prewarm?: boolean;
  /** Leave the host process running after the app quits, so its threads keep going. */
  hostBackground?: boolean;
  /** Hold the host's machine awake while any thread runs a turn. */
  hostKeepAwake?: boolean;
  options?: Record<string, boolean>;
  values?: Record<string, string>;
  keybindings?: Record<string, string>;
  fontFamily?: string;
  fontSize?: number;
  temperature?: number;
  maxTokens?: number;
  models?: TauConfigModels;
  compaction?: TauCompactionConfig;
  retry?: TauRetryConfig;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  defaultTools?: string[];
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  quietStartup?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  vimMode?: boolean;
}

/** One runtime's model list as the user arranged it; models are keyed `provider/id`. */
export interface TauModelPreferences {
  hidden?: string[];
  /** Listed first, in this order; the rest follow in the runtime's own order. */
  order?: string[];
}

export interface CustomModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  providerId: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  hasApiKey?: boolean;
  models: CustomModelDefinition[];
}

export interface ExternalEditorResult {
  text: string;
  modified: boolean;
}

export interface CustomProviderInput {
  providerId: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models: CustomModelDefinition[];
}

export interface SystemPromptInspection {
  /** The effective, full system prompt as sent to the model. */
  effectivePrompt: string;
  /** Base system prompt (custom or default). */
  basePrompt?: string;
  /** File path where the base prompt originated from, if any. */
  basePromptSource?: string;
  /** Prompts appended to the base prompt. */
  appends: Array<{
    text: string;
    source?: string;
  }>;
  /** Project instructions / context files (e.g. AGENTS.md). */
  contextFiles: Array<{
    path: string;
    content: string;
  }>;
}

export interface TauDesktopApi {
  /** Host platform, so the title bar can leave room for native window controls. */
  readonly platform: string;
  /**
   * One request of the host protocol. The response carries either a result or
   * an error; the bridge itself never throws for a failed method.
   */
  request(method: string, params: readonly unknown[]): Promise<HostResponse>;
  /** Validated pushes, each with the sequence a client needs for replay. */
  onHostEvent(listener: (push: HostPush) => void): () => void;
}

declare global {
  interface Window {
    tau?: TauDesktopApi;
  }
}
