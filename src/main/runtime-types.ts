import type { UsageTally } from "./usage-pricing.js";
import type {
  ClientTurnIdentity,
  NewThreadRequestId,
  PreparedPrompt,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiPromptAttachment,
  UiSkillDraft,
  UiThreadGoal,
  UiThreadTree,
  UiThreadUsage,
  UiToolOutputReadResult,
  UiToolRun,
  UiTurnActivityEntry,
  ThreadBackendKind,
  SystemPromptInspection,
} from "../shared/contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ExtensionUiBridge } from "./extension-ui.js";

/**
 * The runtime seam of a thread, in Tau's own vocabulary. Nothing here names a
 * provider SDK: a backend converts at its own edge, so core never learns which
 * program answers a thread (ADR 0005).
 */

/** Where a thread's title came from; a derived title may be replaced by a generated one. */
export type ThreadTitleSource = "derived" | "generated" | "renamed";

export interface ThreadBackendPromptInput {
  text: string;
  delivery: "prompt" | "steer" | "followUp";
  /** Correlates the turn with the renderer's optimistic message. */
  identity?: ClientTurnIdentity;
  prepared?: PreparedPrompt;
  signal?: AbortSignal;
  /** Untrusted composer attachments; each backend decodes what its runtime takes. */
  attachments?: readonly UiPromptAttachment[];
  /** The prompt queues behind a run that is already in flight. */
  queued?: boolean;
  /**
   * Deliver this as a message the transcript does not attribute to the user.
   * Only a backend whose `resume` capability reports `hiddenPrompt` honours it.
   */
  hidden?: boolean;
  /** Reports admission before the turn ends, with an optional preflight refusal reason. */
  onAdmitted?(accepted: boolean, error?: unknown): void;
}

export interface ThreadBackendPromptResult {
  assistantText?: string;
}

/** Cheap synchronous view of a thread's live state. */
export interface ThreadBackendState {
  streaming: boolean;
  idle: boolean;
  /** Whether the runtime holds any message for this thread yet. */
  hasMessages: boolean;
  title?: string;
  titleSource?: ThreadTitleSource;
  /** Where the runtime persists the thread, when that is a file. */
  sessionFile?: string;
  activeTools: readonly string[];
  supportsImageInput: boolean;
  /** Runtime extensions loaded for this thread. */
  extensionCount: number;
}

/** What the composer and the workbench read from a thread without waiting. */
export interface ThreadCatalogView {
  model?: UiModel;
  thinkingLevel: string;
  thinkingLevels: readonly string[];
  allTools: ReadonlyArray<{ name: string; description: string }>;
  contextUsage?: UiContextUsage;
  /** Tokens and money the thread has spent so far, when the runtime tracks them. */
  usage?: UiThreadUsage;
  /** What `usage` was priced from, per provider and model; Pi's own threads carry it for the index's cache. */
  usageTallies?: readonly UsageTally[];
}

export interface ShellCommandResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

/** A raw runtime event; `handleRuntimeSessionEvent` owns its dialect. */
export type RuntimeEventListener = (event: unknown, threadId: string) => void;

/**
 * What a streamed backend without a host-owned journal reports about its
 * thread, in Tau's vocabulary. The host turns these into workbench events and
 * keeps the live turn state; the backend converts from its runtime at its edge.
 * Every event belongs to the thread the backend was opened for.
 */
export type ThreadRuntimeEvent =
  | { type: "turn-started" }
  /**
   * `error` says why a turn with status "error" failed; the transcript and the rail show it.
   * `limit` marks that failure as a provider's usage or rate limit, with its reset (epoch ms)
   * when known; without it the host reads the error text. New in API 1.11.0.
   */
  | { type: "turn-settled"; status: "completed" | "interrupted" | "error"; error?: string; limit?: { resetsAt?: number } }
  | { type: "assistant-start"; id: string; timestamp: number }
  | { type: "assistant-delta"; id: string; delta: string }
  | { type: "assistant-thinking"; id: string; delta: string }
  | { type: "assistant-end"; message: UiMessage }
  | { type: "user-message"; message: UiMessage }
  | { type: "tool-start"; tool: UiToolRun }
  | { type: "tool-update"; id: string; output: string }
  | { type: "tool-end"; tool: UiToolRun }
  | { type: "queue"; steering: string[]; followUp: string[] }
  | { type: "notice"; message: string; level: "info" | "warning" | "error" }
  /** `catalogView().usage` changed; the host republishes the thread's shell. */
  | { type: "usage" }
  /** The backend adopted a title from its runtime; republish its shell. */
  | { type: "title" }
  /** `capabilities.goals.current()` changed; the host republishes the thread's goal. New in API 1.52.0. */
  | { type: "goal" };

/** What the host binds into a runtime that hosts extensions of its own. */
export interface RuntimeExtensionBindings {
  /** The workbench's dialog surface for the runtime's extension questions. */
  ui: ExtensionUiBridge;
  onError(error: unknown): void;
}

/** A chat transcript a runtime normalized itself, for Markdown export. */
export interface RuntimeChatTranscript {
  title?: string;
  cwd?: string;
  threadId?: string;
  messages: Array<{ role?: string; content?: unknown }>;
}

export interface RuntimeNewThreadRequest {
  requestId: NewThreadRequestId;
  projectPath: string;
  initialPrompt?: string;
  attachments: readonly UiPromptAttachment[];
  identity?: ClientTurnIdentity;
  prepared?: PreparedPrompt;
}

export interface RuntimeNewThreadOutcome {
  /** The runtime reported the thread and this backend now points at it. */
  adopted: boolean;
}

// ---------------------------------------------------------------------------
// Capability groups. A backend offers the ones its runtime can serve; the host
// asks for one through `requireCapability` and never per-site.
// ---------------------------------------------------------------------------

/** Raw session entries of a runtime that keeps a durable journal beside its messages. */
export interface ThreadJournalCapability {
  /** Entries on the thread's current branch, in order. */
  entries(): readonly unknown[];
  appendCustomEntry(customType: string, data?: unknown): void;
  appendMessage(message: unknown): void;
}

export interface ThreadTreeCapability {
  tree(): UiThreadTree;
  leafEntryId(): string | undefined;
  navigateTree(entryId: string, options: { summarize?: boolean }): Promise<{ cancelled: boolean; draftText?: string }>;
}

export interface ThreadForkCapability {
  /** The runtime forks itself and reports the result through its own events. */
  readonly runtimeOwned: boolean;
  /** Only for a runtime that forks itself. */
  requestFork?(entryId: string): Promise<void>;
}

export interface ThreadShellActionCapability {
  isRunning(): boolean;
  run(command: string, includeInContext: boolean): Promise<ShellCommandResult>;
}

export interface ThreadCompactionCapability {
  compact(): Promise<void>;
}

/** Selecting the model and thinking level of a thread. */
export interface ThreadCatalogWriteCapability {
  setModel(provider: string, id: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
}

/** One short answer from a model of this runtime, outside the thread's conversation. */
export interface ThreadCompletionCapability {
  complete(provider: string, modelId: string, request: CompletionRequest): Promise<string>;
  /** Models reached through this runtime's own credentials. */
  models?(): Promise<UiModel[]>;
  /** The provider API of the thread's active model, e.g. "openai-responses". */
  modelApi(): string | undefined;
}

/** A runtime whose extensions the host binds its own dialog surface into. */
export interface ThreadExtensionCapability {
  bind(bindings: RuntimeExtensionBindings): Promise<void>;
  unbind(): void;
  /** The runtime tells the host before it replaces the live session, and asks for a rebind after. */
  setLifecycleHooks(beforeInvalidate: () => void, rebind: () => Promise<void>): void;
  shortcuts(userBindings: PiUserKeybindings): PiShortcut[];
  runShortcut(keys: string, userBindings: PiUserKeybindings): Promise<boolean>;
}

/** A runtime that can rediscover its resources without losing the thread. */
export interface ThreadReloadCapability {
  reload(): Promise<void>;
}

/**
 * A runtime that can take a thread back up after a restart cut a turn short.
 * Without this group the host only marks the thread as interrupted; it never
 * guesses that a runtime will accept work it has no record of.
 */
export interface ThreadResumeCapability {
  /** Whether `prompt({ hidden: true })` is honoured; the continuation is an ordinary message otherwise. */
  readonly hiddenPrompt: boolean;
  /** A transcript row that is nobody's message. Absent where the runtime has no such row. */
  notice?(text: string): Promise<void>;
}

export interface ThreadEventCapability {
  subscribe(listener: RuntimeEventListener): () => void;
}

/**
 * A runtime that pages its own transcript and keeps its own tool output. The
 * host preserves its opaque cursor instead of paging the records again.
 */
export interface ThreadTranscriptPagingCapability {
  page(cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
  readToolOutput(toolCallId: string): Promise<UiToolOutputReadResult | undefined>;
}

/**
 * A runtime that keeps the tool cards of its turns, so they return after a
 * restart. The host reads them when the thread opens and hands over its own
 * record of a turn whenever a tool starts or ends and when the turn settles.
 */
export interface ThreadActivityHistoryCapability {
  /** Earlier turns, oldest first; none may still be running. */
  load(): Promise<UiTurnActivityEntry[]>;
  /** The whole turn as the host holds it; a later call for the same `id` replaces it. */
  save(entry: UiTurnActivityEntry): Promise<void>;
}

/** A runtime that normalizes its own chat transcript for export. */
export interface ThreadMarkdownExportCapability {
  exportTranscript(): Promise<RuntimeChatTranscript>;
}

/** A runtime that creates new threads itself; the host only publishes what it reports. */
export interface ThreadNewThreadCapability {
  create(request: RuntimeNewThreadRequest): Promise<RuntimeNewThreadOutcome>;
}

/**
 * The interaction mode a thread's turns run in: `default`, or one the runtime
 * adds (`plan`: explore and propose, change nothing). The mode belongs to the
 * thread and applies from the next turn on; a runtime maps it onto its own
 * policy the way it maps the access level.
 */
export interface ThreadModeCapability {
  /** The modes besides `default` this thread offers. */
  modes(): readonly string[];
  current(): string;
  /** Refuses a mode the thread does not offer. */
  set(mode: string): Promise<void>;
}

/**
 * A runtime that pursues a goal across turns of its own: Codex's
 * `thread/goal`, Claude Code's `/goal`. The runtime keeps the goal and starts
 * its turns; Tau never loops prompts for it. A backend that cannot pause says
 * so in `actions`, and one whose run ended without a verdict answers
 * `unconfirmed`, never `complete`. Report changes with a `goal` event.
 */
export interface ThreadGoalCapability {
  current(): UiThreadGoal | undefined;
  /**
   * Replaces any goal; the host then sends its first turn as an ordinary
   * prompt: `prompt` when the runtime names one (Claude Code's `/goal …`),
   * else the objective.
   */
  set(objective: string): Promise<{ prompt: string } | void>;
  /** No further goal turn starts; a running one finishes. */
  pause(): Promise<void>;
  /** Starts the next goal turn, itself or through the prompt it answers. */
  resume(): Promise<{ prompt: string } | void>;
  clear(): Promise<void>;
  /** Forgets a goal that ended (met, not confirmed); the runtime has none any more. */
  dismiss?(): Promise<void>;
}

export interface ThreadSystemPromptCapability {
  inspect(): Promise<SystemPromptInspection> | SystemPromptInspection;
}

export interface ThreadBackendCapabilities {
  journal?: ThreadJournalCapability;
  tree?: ThreadTreeCapability;
  fork?: ThreadForkCapability;
  shellAction?: ThreadShellActionCapability;
  compaction?: ThreadCompactionCapability;
  catalogWrite?: ThreadCatalogWriteCapability;
  completions?: ThreadCompletionCapability;
  /** A runtime's session name, excluding its first-prompt fallback. */
  titles?: { title(): Promise<string | undefined> };
  extensions?: ThreadExtensionCapability;
  reload?: ThreadReloadCapability;
  /** Stops runtime resources while retaining the provider session for resume. */
  restart?: { restart(): Promise<void> };
  resume?: ThreadResumeCapability;
  events?: ThreadEventCapability;
  transcriptPaging?: ThreadTranscriptPagingCapability;
  activityHistory?: ThreadActivityHistoryCapability;
  markdownExport?: ThreadMarkdownExportCapability;
  newThread?: ThreadNewThreadCapability;
  systemPrompt?: ThreadSystemPromptCapability;
  mode?: ThreadModeCapability;
  goals?: ThreadGoalCapability;
}

export type ThreadCapabilityName = keyof ThreadBackendCapabilities;

/** The one error the host raises for anything a thread's runtime cannot do. */
export class UnsupportedOperationError extends Error {
  constructor(
    readonly capability: ThreadCapabilityName,
    readonly backendKind: ThreadBackendKind,
    hint?: string,
  ) {
    super(`${CAPABILITY_LABELS[capability]} is not available for this thread's runtime (${backendKind}).${hint ? ` ${hint}` : ""}`);
    this.name = "UnsupportedOperationError";
  }
}

const CAPABILITY_LABELS: Record<ThreadCapabilityName, string> = {
  journal: "The session journal",
  tree: "The session tree",
  fork: "Forking",
  shellAction: "Project actions",
  compaction: "Context compaction",
  catalogWrite: "Model selection",
  completions: "Model completions",
  titles: "Runtime titles",
  extensions: "Runtime extensions",
  reload: "Reloading runtime resources",
  restart: "Restarting the agent session",
  resume: "Continuing an interrupted turn",
  events: "Runtime events",
  transcriptPaging: "Runtime-paged transcripts",
  activityHistory: "Tool history",
  markdownExport: "Markdown export",
  newThread: "Runtime-owned new threads",
  systemPrompt: "System prompt inspection",
  mode: "Interaction modes",
  goals: "Goals",
};

/**
 * One durable runtime per thread (ADR 0005). The required members are what
 * every runtime must answer; everything else is a capability group.
 */
export interface ThreadRuntimeBackend {
  /** Runtime owner for this thread. This value never changes while live. */
  readonly kind: ThreadBackendKind;
  readonly runtimeAdapter: AgentRuntimeAdapter;
  /** Tau's stable thread id. Provider session ids never cross this boundary. */
  readonly threadId: string;
  /** Runtime-owned provider session id. */
  readonly providerSessionId: string;
  readonly cwd: string;
  readonly capabilities: ThreadBackendCapabilities;
  /**
   * Who reports run state: a streamed runtime publishes its own events, an
   * awaited one resolves `prompt` when the turn ends and the host tracks it.
   */
  readonly turnReporting: "streamed" | "awaited";

  start(mode: "create" | "resume"): Promise<void>;
  dispose(): Promise<void>;
  state(): ThreadBackendState;
  waitForIdle(): Promise<void>;

  preparePrompt(text: string, skill?: UiSkillDraft): Promise<PreparedPrompt>;
  prompt(input: ThreadBackendPromptInput): Promise<ThreadBackendPromptResult>;
  abort(): Promise<void>;

  /** The thread's visible messages. */
  transcript(): Promise<UiMessage[]>;
  /** Records the visible projection the host holds; a runtime that persists on its own may ignore it. */
  persist(messages: readonly UiMessage[]): Promise<void>;
  setTitle(title: string, source: ThreadTitleSource): Promise<void>;

  catalogView(): ThreadCatalogView;
  /** Models this runtime offers; the slow half of the catalog. */
  models(): Promise<UiModel[]>;
  composerCommands(): UiComposerCommand[];
}

/** The one place the host asks whether a thread's runtime can do something. */
export function requireCapability<K extends ThreadCapabilityName>(
  backend: ThreadRuntimeBackend,
  capability: K,
  hint?: string,
): NonNullable<ThreadBackendCapabilities[K]> {
  const group = backend.capabilities[capability];
  if (!group) throw new UnsupportedOperationError(capability, backend.kind, hint);
  return group as NonNullable<ThreadBackendCapabilities[K]>;
}
