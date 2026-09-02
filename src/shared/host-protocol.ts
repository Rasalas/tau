import type {
  HostSnapshot,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiTaskProgress,
  UiTaskProgressEntry,
  UiTurnActivityEntry,
  UiToolRun,
  UiTurnActivity,
  SubmissionResult,
  NewThreadRequestId,
  ThreadBackendKind,
} from "./contracts.js";
import type { UiWorkspaceChanges } from "./workspace-kit-types.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import type { ThreadTranscriptPage, TranscriptBundle, TranscriptCursorBoundary } from "./transcript-contract.js";
import { isTranscriptHistoryMetadataConsistent, resolveTranscriptHistoryCompleteness } from "./transcript-completeness.js";
import { isHostTranscriptCursor, type HostTranscriptCursor } from "./transcript-cursor.js";
import { INITIAL_TRANSCRIPT_TURN_LIMIT, TranscriptPager, type TranscriptCursorPolicy } from "./transcript-pager.js";

/** The wire version is deliberately independent from the Pi SDK version. */
export const HOST_PROTOCOL_VERSION = 1 as const;
export type HostProtocolVersion = typeof HOST_PROTOCOL_VERSION;

export interface ThreadShellUpdate {
  sessionId: string;
  shell?: ThreadIndexSnapshot["sessions"][number];
  removed?: boolean;
}

export interface ThreadIndexUpdate {
  projects: ThreadIndexSnapshot["projects"];
  sessions: ThreadIndexSnapshot["sessions"];
}

export interface ThreadDetail extends TranscriptBundle<UiMessage, HostTranscriptCursor> {
  /** Canonical Tau thread owner; sessionId is retained for v1 clients. */
  threadId?: string;
  /** Provider-owned runtime session id, when the backend has one. */
  providerSessionId?: string;
  /** @deprecated v1 alias for the Tau thread id. */
  sessionId: string;
  /** Present only when this detail completes a correlated bridge handoff. */
  requestId?: NewThreadRequestId;
  /** Runtime lifecycle owner for this thread; absent for old clients. */
  backendKind?: ThreadBackendKind;
  isStreaming: boolean;
  activeTools: string[];
  turnActivity?: UiTurnActivity;
  turnCheckpoints?: UiTurnCheckpoint[];
  taskProgress?: UiTaskProgress;
  contextUsage?: UiContextUsage;
  /** Whether another page exists; omitted by older protocol peers. */
  hasMore?: boolean;
  /** Whether completed turn checkpoints can safely restore this thread; missing means unsupported. */
  supportsCheckpointRestore?: boolean;
}

/** A bounded page carrying only checkpoints anchored in the visible messages. */
export type TranscriptPage = ThreadTranscriptPage<UiMessage, HostTranscriptCursor> & {
  turnCheckpoints?: UiTurnCheckpoint[];
};

/** Keep checkpoint summaries attached only to assistant messages exposed by this page. */
export function checkpointsForMessages(
  checkpoints: readonly UiTurnCheckpoint[] | undefined,
  messages: readonly UiMessage[],
): UiTurnCheckpoint[] {
  if (!checkpoints || checkpoints.length === 0) return [];
  const ids = new Set(messages.flatMap((message) => [message.id, ...(message.sourceEntryId ? [message.sourceEntryId] : [])]));
  return checkpoints.filter((checkpoint) => ids.has(checkpoint.anchorMessageId));
}

export function messageHasCheckpointAnchor(
  message: UiMessage | undefined,
  checkpoints: readonly UiTurnCheckpoint[] | undefined,
): boolean {
  if (!message || !checkpoints || checkpoints.length === 0) return false;
  return checkpoints.some((checkpoint) => checkpoint.anchorMessageId === message.id
    || checkpoint.anchorMessageId === message.sourceEntryId);
}

export interface HostCatalog {
  /** Absent in legacy v1 catalogs; clients must not apply capability without it. */
  sessionId?: string;
  /** Runtime lifecycle owner for the active thread; absent for old clients. */
  backendKind?: ThreadBackendKind;
  models: UiModel[];
  model?: UiModel;
  runtimeCapabilities?: import("./contracts.js").RuntimeCapabilities;
  thinkingLevel: string;
  thinkingLevels: string[];
  allTools: Array<{ name: string; description: string }>;
  composerCommands?: UiComposerCommand[];
  extensionCount: number;
  /** Optional in protocol v1; absent means the runtime does not accept images. */
  supportsImageInput?: boolean;
}

export interface ProjectMetadata {
  cwd: string;
  branch?: string;
  changes?: UiWorkspaceChanges;
}

export type HostUpdate =
  | { version: HostProtocolVersion; type: "thread-index"; index: ThreadIndexUpdate }
  | { version: HostProtocolVersion; type: "thread-shell"; update: ThreadShellUpdate }
  | { version: HostProtocolVersion; type: "thread-detail"; detail: ThreadDetail }
  | { version: HostProtocolVersion; type: "transcript-page"; page: TranscriptPage }
  | { version: HostProtocolVersion; type: "catalog"; catalog: HostCatalog }
  | { version: HostProtocolVersion; type: "project"; project: ProjectMetadata }
  | { version: HostProtocolVersion; type: "run"; event: "started" | "settled" | "aborted"; sessionId: string }
  | { version: HostProtocolVersion; type: "error"; message: string };

export interface HostActionResult {
  version: HostProtocolVersion;
  updates: HostUpdate[];
}

export interface NewThreadResult extends HostActionResult {
  submission: SubmissionResult;
  /** Correlates a bridge replacement with the originating composer request. */
  requestId?: NewThreadRequestId;
  /** Runtime identity assigned before detached prompt delivery finishes. */
  sessionId?: string;
}

/** Bootstrap is shell-first; no legacy full snapshot crosses IPC. */
export interface GranularHostBootstrap {
  version: HostProtocolVersion;
  detail: ThreadDetail;
  catalog: HostCatalog;
  project: ProjectMetadata;
  index?: ThreadIndexUpdate;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function validCursor(value: unknown): boolean {
  return value === undefined || isHostTranscriptCursor(value);
}

function validTranscriptWindow(value: unknown): boolean {
  return value === undefined || value === "bounded";
}

function hasProviderCoordinates(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, "transcriptMessageIndexes")
    || Object.prototype.hasOwnProperty.call(value, "messagesOffset");
}

function validCursorBoundaries(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((boundary) => {
    const item = record(boundary);
    return Boolean(item && typeof item.messageId === "string" && validCursor(item.cursor));
  }));
}

function validTranscriptBundlePayload(payload: Record<string, unknown>, requireHasMore: boolean): boolean {
  return !hasProviderCoordinates(payload)
    && typeof payload.sessionId === "string"
    && Array.isArray(payload.messages)
    && validCursor(payload.olderCursor)
    && validCursorBoundaries(payload.cursorBoundaries)
    && validTranscriptWindow(payload.transcriptWindow)
    && isTranscriptHistoryMetadataConsistent({
      hasMore: payload.hasMore,
      hasCursor: payload.olderCursor !== undefined,
      historyCompleteness: payload.historyCompleteness,
      requireHasMore,
    })
    && (payload.taskHistory === undefined || Array.isArray(payload.taskHistory))
    && (payload.turnActivityHistory === undefined || Array.isArray(payload.turnActivityHistory))
    && (payload.turnActivityHistoryComplete === undefined || typeof payload.turnActivityHistoryComplete === "boolean");
}

export function isHostUpdate(value: unknown): value is HostUpdate {
  const candidate = record(value);
  if (!candidate || candidate.version !== HOST_PROTOCOL_VERSION || typeof candidate.type !== "string") return false;
  const payload = record(candidate[
    candidate.type === "thread-index" ? "index" :
      candidate.type === "thread-shell" ? "update" :
        candidate.type === "thread-detail" ? "detail" :
          candidate.type === "transcript-page" ? "page" :
            candidate.type === "catalog" ? "catalog" :
              candidate.type === "project" ? "project" : ""
  ]);
  switch (candidate.type) {
    case "thread-index": return Boolean(payload && Array.isArray(payload.projects) && Array.isArray(payload.sessions));
    case "thread-shell": return Boolean(payload && typeof payload.sessionId === "string" && (payload.shell === undefined || record(payload.shell)));
    case "thread-detail": return Boolean(payload && validTranscriptBundlePayload(payload, false)
      && (payload.requestId === undefined || typeof payload.requestId === "string")
      && typeof payload.isStreaming === "boolean" && Array.isArray(payload.activeTools));
    case "transcript-page": return Boolean(payload && validTranscriptBundlePayload(payload, true)
      && typeof payload.hasMore === "boolean");
    case "catalog": return Boolean(payload && (payload.sessionId === undefined || typeof payload.sessionId === "string") && Array.isArray(payload.models) && typeof payload.thinkingLevel === "string" && Array.isArray(payload.thinkingLevels) && Array.isArray(payload.allTools) && typeof payload.extensionCount === "number" && (payload.supportsImageInput === undefined || typeof payload.supportsImageInput === "boolean"));
    case "project": return Boolean(payload && typeof payload.cwd === "string");
    case "run": return typeof candidate.sessionId === "string" && ["started", "settled", "aborted"].includes(String(candidate.event));
    case "error": return typeof candidate.message === "string";
    default: return false;
  }
}

/** Unknown versions/types are ignored rather than interpreted as snapshots. */
export function decodeHostUpdates(value: unknown): HostUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isHostUpdate);
}

export function taskHistoryForMessages(
  history: readonly UiTaskProgressEntry[] | undefined,
  messages: readonly UiMessage[],
): UiTaskProgressEntry[] | undefined {
  if (!history) return undefined;
  const ids = new Set(messages.map((message) => message.id));
  return history.filter((entry) => !entry.anchorMessageId || ids.has(entry.anchorMessageId));
}

/** Keep historical tool groups attached only to rows exposed by this page. */
export function turnActivityHistoryForMessages(
  history: readonly UiTurnActivityEntry[] | undefined,
  messages: readonly UiMessage[],
): UiTurnActivityEntry[] | undefined {
  if (!history) return undefined;
  const ids = new Set(messages.flatMap((message) => [message.id, ...(message.sourceEntryId ? [message.sourceEntryId] : [])]));
  return history.filter((entry) => !entry.anchorMessageId || ids.has(entry.anchorMessageId));
}

/**
 * Normalize all opaque page-boundary metadata through one host/shared policy.
 * An explicit boundary wins over the legacy direct pair for the same message;
 * no cursor syntax or provider coordinate is interpreted here.
 */
export function normalizeTranscriptCursorBoundaries<TCursor extends string = HostTranscriptCursor>(
  boundaries: readonly TranscriptCursorBoundary<TCursor>[] | undefined,
  cursorBeforeMessageId?: string,
  olderCursor?: TCursor,
): TranscriptCursorBoundary<TCursor>[] | undefined {
  const byMessageId = new Map<string, TranscriptCursorBoundary<TCursor>>();
  for (const boundary of boundaries ?? []) {
    if (boundary.messageId && boundary.cursor) byMessageId.set(boundary.messageId, {
      messageId: boundary.messageId,
      cursor: boundary.cursor,
    });
  }
  if (cursorBeforeMessageId && olderCursor) {
    if (!byMessageId.has(cursorBeforeMessageId)) {
      byMessageId.set(cursorBeforeMessageId, { messageId: cursorBeforeMessageId, cursor: olderCursor });
    }
  }
  return byMessageId.size > 0 ? [...byMessageId.values()] : undefined;
}

/** Project a full host snapshot into the focused thread-detail contract. */
export function threadDetailFromHostSnapshot(snapshot: HostSnapshot): ThreadDetail {
  const cursorBoundaries = normalizeTranscriptCursorBoundaries(
    snapshot.cursorBoundaries,
    snapshot.cursorBeforeMessageId,
    snapshot.olderCursor,
  );
  return {
    threadId: snapshot.threadId ?? snapshot.sessionId,
    ...(snapshot.providerSessionId ? { providerSessionId: snapshot.providerSessionId } : {}),
    sessionId: snapshot.sessionId,
    messages: snapshot.messages,
    ...(snapshot.backendKind ? { backendKind: snapshot.backendKind } : {}),
    isStreaming: snapshot.isStreaming,
    activeTools: snapshot.activeTools,
    turnActivity: snapshot.turnActivity,
    turnCheckpoints: checkpointsForMessages(snapshot.turnCheckpoints, snapshot.messages),
    taskProgress: snapshot.taskProgress,
    taskHistory: snapshot.taskHistory,
    turnActivityHistory: turnActivityHistoryForMessages(snapshot.turnActivityHistory, snapshot.messages),
    ...(snapshot.turnActivityHistoryComplete !== undefined
      ? { turnActivityHistoryComplete: snapshot.turnActivityHistoryComplete }
      : {}),
    contextUsage: snapshot.contextUsage,
    olderCursor: snapshot.olderCursor,
    cursorBeforeMessageId: snapshot.cursorBeforeMessageId,
    cursorBoundaries,
    hasMore: snapshot.olderCursor !== undefined,
    historyCompleteness: snapshot.historyCompleteness,
    supportsCheckpointRestore: snapshot.supportsCheckpointRestore,
    ...(snapshot.transcriptWindow ? { transcriptWindow: snapshot.transcriptWindow } : {}),
  };
}

/** Project focused detail back onto the host snapshot shape without duplicating fields at call sites. */
export function hostSnapshotFromThreadDetail(snapshot: HostSnapshot, detail: ThreadDetail): HostSnapshot {
  const cursorBoundaries = normalizeTranscriptCursorBoundaries(
    detail.cursorBoundaries,
    detail.cursorBeforeMessageId,
    detail.olderCursor,
  );
  const transcriptWindow = detail.transcriptWindow ?? snapshot.transcriptWindow;
  return {
    ...snapshot,
    sessionId: detail.sessionId,
    messages: detail.messages,
    taskHistory: detail.taskHistory,
    turnActivityHistory: detail.turnActivityHistory,
    ...(detail.turnActivityHistoryComplete !== undefined
      ? { turnActivityHistoryComplete: detail.turnActivityHistoryComplete }
      : {}),
    olderCursor: detail.olderCursor,
    cursorBeforeMessageId: detail.cursorBeforeMessageId,
    cursorBoundaries,
    historyCompleteness: detail.historyCompleteness,
    ...(transcriptWindow ? { transcriptWindow } : {}),
    isStreaming: detail.isStreaming,
    activeTools: detail.activeTools,
    turnActivity: detail.turnActivity,
    turnCheckpoints: detail.turnCheckpoints,
    taskProgress: detail.taskProgress,
    contextUsage: detail.contextUsage,
    supportsCheckpointRestore: detail.supportsCheckpointRestore,
  };
}

export function detailFromSnapshot(
  snapshot: HostSnapshot,
  limit = INITIAL_TRANSCRIPT_TURN_LIMIT,
  policy?: TranscriptCursorPolicy<HostTranscriptCursor>,
): ThreadDetail {
  const alreadyBounded = snapshot.transcriptWindow === "bounded" || snapshot.messages.length <= limit;
  if (alreadyBounded) return {
    ...threadDetailFromHostSnapshot(snapshot),
    messages: [...snapshot.messages],
    activeTools: [...snapshot.activeTools],
    turnCheckpoints: checkpointsForMessages(snapshot.turnCheckpoints, snapshot.messages),
    taskHistory: taskHistoryForMessages(snapshot.taskHistory, snapshot.messages),
    turnActivityHistory: turnActivityHistoryForMessages(snapshot.turnActivityHistory, snapshot.messages),
    ...(snapshot.turnActivityHistoryComplete !== undefined
      ? { turnActivityHistoryComplete: snapshot.turnActivityHistoryComplete }
      : {}),
    hasMore: snapshot.olderCursor !== undefined,
    historyCompleteness: resolveTranscriptHistoryCompleteness(
      snapshot.historyCompleteness,
      snapshot.olderCursor !== undefined,
    ),
    transcriptWindow: "bounded",
  };
  if (!policy) throw new Error("A host transcript cursor policy is required to bound a full snapshot.");
  const page = TranscriptPager.pageFor(
    snapshot.sessionId,
    snapshot.messages,
    limit,
    undefined,
    policy,
  );
  const boundedWithoutPaging = snapshot.historyCompleteness === "unknown";
  const olderCursor = boundedWithoutPaging ? undefined : page.olderCursor;
  const firstUserMessage = page.messages.find((message) => message.role === "user");
  return {
    sessionId: snapshot.sessionId,
    messages: page.messages,
    isStreaming: snapshot.isStreaming,
    activeTools: [...snapshot.activeTools],
    turnActivity: snapshot.turnActivity,
    taskProgress: snapshot.taskProgress,
    taskHistory: taskHistoryForMessages(snapshot.taskHistory, page.messages),
    turnActivityHistory: turnActivityHistoryForMessages(snapshot.turnActivityHistory, page.messages),
    ...(snapshot.turnActivityHistoryComplete !== undefined
      ? { turnActivityHistoryComplete: snapshot.turnActivityHistoryComplete }
      : {}),
    contextUsage: snapshot.contextUsage,
    ...(olderCursor ? { olderCursor } : {}),
    ...(firstUserMessage ? { cursorBeforeMessageId: firstUserMessage.id } : {}),
    ...(olderCursor && firstUserMessage ? {
      cursorBoundaries: [{ messageId: firstUserMessage.id, cursor: olderCursor }],
    } : {}),
    hasMore: Boolean(olderCursor),
    historyCompleteness: resolveTranscriptHistoryCompleteness(
      snapshot.historyCompleteness,
      Boolean(olderCursor),
    ),
    transcriptWindow: "bounded",
    turnCheckpoints: checkpointsForMessages(snapshot.turnCheckpoints, page.messages),
    supportsCheckpointRestore: snapshot.supportsCheckpointRestore,
  };
}

export function catalogFromSnapshot(snapshot: HostSnapshot): HostCatalog {
  return {
    sessionId: snapshot.sessionId,
    ...(snapshot.backendKind ? { backendKind: snapshot.backendKind } : {}),
    models: [...snapshot.models],
    model: snapshot.model,
    runtimeCapabilities: snapshot.runtimeCapabilities,
    thinkingLevel: snapshot.thinkingLevel,
    thinkingLevels: [...snapshot.thinkingLevels],
    allTools: [...snapshot.allTools],
    composerCommands: snapshot.composerCommands?.map((command) => ({ ...command })),
    extensionCount: snapshot.extensionCount,
    supportsImageInput: snapshot.supportsImageInput ?? false,
  };
}
