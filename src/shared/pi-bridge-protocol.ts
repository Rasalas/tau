import type {
  ClientTurnIdentity,
  DiffLoadOptions,
  ExtensionUiPromptKind,
  NewThreadRequestId,
  RuntimeCapabilities,
  UiComposerCommand,
  UiPromptAttachment,
  UiSkillInvocation,
  UiTaskProgress,
  UiTaskProgressEntry,
  UiTurnCheckpoint,
  UiWorkspaceChangesPage,
} from "./contracts.js";
import type { ThreadTranscriptPage, TranscriptBundle } from "./transcript-contract.js";

export const PI_BRIDGE_PROTOCOL_VERSION = 1;
/** Allows the composer's 24 MB decoded image budget plus base64 and JSON overhead. */
export const PI_BRIDGE_MAX_FRAME_BYTES = 40 * 1024 * 1024;

/** Optional v1 capabilities negotiated by the hello/ready exchange. */
export interface PiBridgeCapabilities {
  transcriptPaging?: boolean;
}

export const PI_BRIDGE_CLIENT_CAPABILITIES: PiBridgeCapabilities = {
  transcriptPaging: true,
};

export function transcriptPagingNegotiated(capabilities?: PiBridgeCapabilities): boolean {
  return capabilities?.transcriptPaging === true;
}

export interface PiBridgeDescriptor {
  protocolVersion: 1;
  epoch: string;
  /** Canonical Tau owner id; sessionId is retained for the v1 bridge wire. */
  threadId?: string;
  /** Pi's provider session id (equal to its Tau thread id for this adapter). */
  providerSessionId?: string;
  /** @deprecated v1 alias for the Tau thread id. */
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  socketPath: string;
  token: string;
  startedAt: number;
}

/** Wire payload: the bridge cursor remains an opaque JSON string at this seam. */
export interface PiBridgeSnapshot extends TranscriptBundle<unknown, string> {
  /** Canonical Tau owner id; sessionId is retained for old bridges. */
  threadId?: string;
  /** Provider session id owned by Pi. */
  providerSessionId?: string;
  /** @deprecated v1 alias for the Tau thread id. */
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sessionName?: string;
  /** Raw branch index of the first entry in `messages`. */
  messagesOffset?: number;
  /** Capabilities selected for this client; absent means legacy v1 semantics. */
  capabilities?: PiBridgeCapabilities;
  isStreaming: boolean;
  model?: { provider: string; id: string; name?: string };
  /** Syntax supported by the attached runtime adapter; absent only for older bridges. */
  runtimeCapabilities?: RuntimeCapabilities;
  /** Request ids canceled while the bridge was restarted; consumed by the host during attach. */
  failedClientMessageIds?: string[];
  models: Array<{ provider: string; id: string; name?: string }>;
  thinkingLevel: string;
  thinkingLevels: string[];
  activeTools: string[];
  allTools: Array<{ name: string; description: string }>;
  /** Whether the active Pi model accepts image prompt input. */
  supportsImageInput: boolean;
  /** Optional for compatibility with Pi instances running an older bridge. */
  composerCommands?: UiComposerCommand[];
  /** Raw records for restoring completed tool activity; the transcript page is mapped separately. */
  activityMessages?: unknown[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
  /** Optional because older Pi bridge extensions do not provide checkpoints. */
  turnCheckpoints?: UiTurnCheckpoint[];
  /** Cursor for raw records older than the newest bridge snapshot page. */
  olderCursor?: string;
  /** Set while Pi blocks on an extension question in its own terminal. */
  awaitingInput?: PiBridgeAwaitingInput;
  /** Token echoed once a registered new-session command has actually switched sessions. */
  newSessionRequestId?: NewThreadRequestId;
}

/** A bounded raw branch page returned by a Pi-owned runtime. */
/** Wire payload: callers normalize the raw cursor before routing it further. */
export interface PiBridgeTranscriptPage extends ThreadTranscriptPage<unknown, string> {
  /** Raw branch index of the first entry in `messages`. */
  messagesOffset?: number;
  /** Bounded raw activity records accompanying the mapped transcript page. */
  activityMessages?: unknown[];
  /** Typed activity metadata is computed before raw activity record limits. */
  turnActivityHistory?: import("./contracts.js").UiTurnActivityEntry[];
  /** False when the bridge had to omit activity metadata at its explicit cap. */
  turnActivityHistoryComplete?: boolean;
  /** Checkpoints whose anchors are present in this page. */
  turnCheckpoints?: UiTurnCheckpoint[];
}

/**
 * Runtime-owned prompt data returned by the Pi bridge preflight. Keeping this
 * shape in the bridge protocol lets the extension perform normalization once
 * against its live command registry; the host only transports the result.
 */
export interface PiBridgePreparedPrompt {
  visibleText: string;
  runtimeText: string;
  runtimeCapabilities: RuntimeCapabilities;
  skill?: UiSkillInvocation;
  sourceFingerprint: string;
}

export type PiBridgeCommand =
  | { command: "prepare_prompt"; text: string; skill?: import("./contracts.js").UiSkillDraft }
  | {
      command: "prompt";
      text: string;
      /** Checkpoint lifecycle correlation; required for newly created turns. */
      clientTurnId?: string;
      /** Renderer submission correlation retained by the bridge handoff flow. */
      clientMessageId?: string;
      deliverAs?: "steer" | "followUp";
      attachments?: UiPromptAttachment[];
      prepared?: PiBridgePreparedPrompt;
    }
      & Partial<ClientTurnIdentity>
  | { command: "abort" }
  | { command: "set_thinking"; level: string }
  | { command: "set_model"; provider: string; id: string }
  | { command: "compact" }
  | { command: "reload" }
  | { command: "set_session_name"; name: string }
  | { command: "fork"; entryId: string }
  | ({ command: "new_session"; initialPrompt?: string; attachments?: UiPromptAttachment[]; requestId?: NewThreadRequestId; prepared?: PiBridgePreparedPrompt } & Partial<ClientTurnIdentity>)
  | { command: "new_session_ack"; requestId: NewThreadRequestId; sessionId: string; bridgeEpoch: string }
  | { command: "new_session_abort"; requestId: NewThreadRequestId; sessionId: string; bridgeEpoch: string }
  | { command: "transcript_page"; cursor?: string }
  | { command: "read_tool_output"; toolCallId: string; offset?: number }
  | { command: "turn_files_page"; checkpointId: string; cursor?: string; limit?: number }
      & Partial<ClientTurnIdentity>
  | { command: "export_markdown" }
  | ({ command: "turn_file_diff"; checkpointId: string; path: string } & DiffLoadOptions)
  | { command: "snapshot" }
  | { command: "ping" };

export interface PiBridgeTurnFilesPage extends UiWorkspaceChangesPage {
  sessionId: string;
  checkpointId: string;
}

/** One bounded page of the persisted output requested by the host. */
export interface PiBridgeToolOutputPage {
  toolCallId: string;
  offset: number;
  output: string;
  totalBytes: number;
  nextOffset?: number;
}

/**
 * A blocking question Pi is waiting on. Pi owns its own UI context while it owns
 * the runtime, so the question itself is answered in Pi's terminal; Tau can only
 * report that the thread is stalled on it.
 */
export interface PiBridgeAwaitingInput {
  kind: ExtensionUiPromptKind;
  title?: string;
}

export type PiBridgeClientFrame =
  | { protocolVersion: 1; type: "hello"; id: string; epoch: string; token: string; expectedSessionId: string; capabilities?: PiBridgeCapabilities }
  | ({ protocolVersion: 1; type: "command"; id: string; epoch: string; expectedSessionId: string } & PiBridgeCommand);

export type PiBridgeServerFrame =
  | { protocolVersion: 1; type: "ready"; id: string; epoch: string; snapshot: PiBridgeSnapshot }
  | { protocolVersion: 1; type: "response"; id: string; epoch: string; ok: true; result?: unknown }
  | { protocolVersion: 1; type: "response"; id: string; epoch: string; ok: false; error: string }
  | { protocolVersion: 1; type: "event"; epoch: string; seq: number; sessionId: string; event: unknown }
  | { protocolVersion: 1; type: "snapshot"; epoch: string; seq: number; snapshot: PiBridgeSnapshot };

export function isPiBridgeDescriptor(value: unknown): value is PiBridgeDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.protocolVersion === PI_BRIDGE_PROTOCOL_VERSION
    && typeof item.epoch === "string"
    && (item.threadId === undefined || typeof item.threadId === "string")
    && (item.providerSessionId === undefined || typeof item.providerSessionId === "string")
    && typeof item.sessionId === "string"
    && typeof item.sessionFile === "string"
    && typeof item.cwd === "string"
    && typeof item.pid === "number"
    && typeof item.socketPath === "string"
    && typeof item.token === "string"
    && typeof item.startedAt === "number";
}

export function encodePiBridgeFrame(frame: PiBridgeClientFrame | PiBridgeServerFrame): string {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES) {
    throw new Error("Pi bridge frame exceeds the size limit.");
  }
  return encoded;
}
