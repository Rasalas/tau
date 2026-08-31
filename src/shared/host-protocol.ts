import type {
  HostSnapshot,
  ServiceTier,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiTaskProgress,
  UiTaskProgressEntry,
  UiToolRun,
  UiTurnActivity,
  UiWorkspaceChanges,
} from "./contracts.js";
import type { ThreadTranscriptPage, TranscriptBundle } from "./transcript-contract.js";
import { isTranscriptHistoryMetadataConsistent, resolveTranscriptHistoryCompleteness } from "./transcript-completeness.js";
import { messageIdToRawIndexProjection, projectRawIndexesByMessageId } from "./transcript-indexes.js";
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

export interface ThreadDetail extends TranscriptBundle<UiMessage, number[], HostTranscriptCursor> {
  sessionId: string;
  isStreaming: boolean;
  activeTools: string[];
  turnActivity?: UiTurnActivity;
  taskProgress?: UiTaskProgress;
  contextUsage?: UiContextUsage;
  /** Whether another page exists; omitted by older protocol peers. */
  hasMore?: boolean;
}

export type TranscriptPage = ThreadTranscriptPage<UiMessage, number[], HostTranscriptCursor>;

export interface HostCatalog {
  models: UiModel[];
  model?: UiModel;
  thinkingLevel: string;
  thinkingLevels: string[];
  serviceTier: ServiceTier;
  serviceTierAvailable: boolean;
  allTools: Array<{ name: string; description: string }>;
  composerCommands?: UiComposerCommand[];
  extensionCount: number;
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

function validIndexes(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((index) => Number.isSafeInteger(index) && index >= 0));
}

function validCursor(value: unknown): boolean {
  return value === undefined || isHostTranscriptCursor(value);
}

function validCursorBoundaries(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((boundary) => {
    const item = record(boundary);
    return Boolean(item && typeof item.messageId === "string" && validCursor(item.cursor));
  }));
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
    case "thread-detail": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.messages) && typeof payload.isStreaming === "boolean" && Array.isArray(payload.activeTools)
      && validCursor(payload.olderCursor)
      && validCursorBoundaries(payload.cursorBoundaries)
      && isTranscriptHistoryMetadataConsistent({
        hasMore: payload.hasMore,
        hasCursor: payload.olderCursor !== undefined,
        historyCompleteness: payload.historyCompleteness,
        requireHasMore: false,
      })
      && validIndexes(payload.transcriptMessageIndexes)
      && (payload.taskHistory === undefined || Array.isArray(payload.taskHistory)));
    case "transcript-page": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.messages) && typeof payload.hasMore === "boolean"
      && validCursor(payload.olderCursor)
      && validCursorBoundaries(payload.cursorBoundaries)
      && isTranscriptHistoryMetadataConsistent({
        hasMore: payload.hasMore,
        hasCursor: payload.olderCursor !== undefined,
        historyCompleteness: payload.historyCompleteness,
        requireHasMore: true,
      })
      && validIndexes(payload.transcriptMessageIndexes)
      && (payload.taskHistory === undefined || Array.isArray(payload.taskHistory)));
    case "catalog": return Boolean(payload && Array.isArray(payload.models) && typeof payload.thinkingLevel === "string" && Array.isArray(payload.thinkingLevels) && Array.isArray(payload.allTools) && typeof payload.extensionCount === "number");
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

/** Project a full host snapshot into the focused thread-detail contract. */
export function threadDetailFromHostSnapshot(snapshot: HostSnapshot): ThreadDetail {
  const cursorBoundaries = snapshot.cursorBoundaries
    ?? (snapshot.olderCursor && snapshot.cursorBeforeMessageId
      ? [{ messageId: snapshot.cursorBeforeMessageId, cursor: snapshot.olderCursor }]
      : undefined);
  return {
    sessionId: snapshot.sessionId,
    messages: snapshot.messages,
    transcriptMessageIndexes: snapshot.transcriptMessageIndexes,
    isStreaming: snapshot.isStreaming,
    activeTools: snapshot.activeTools,
    turnActivity: snapshot.turnActivity,
    taskProgress: snapshot.taskProgress,
    taskHistory: snapshot.taskHistory,
    contextUsage: snapshot.contextUsage,
    olderCursor: snapshot.olderCursor,
    cursorBeforeMessageId: snapshot.cursorBeforeMessageId,
    cursorBoundaries,
    hasMore: snapshot.olderCursor !== undefined,
    historyCompleteness: snapshot.historyCompleteness,
  };
}

/** Project focused detail back onto the host snapshot shape without duplicating fields at call sites. */
export function hostSnapshotFromThreadDetail(snapshot: HostSnapshot, detail: ThreadDetail): HostSnapshot {
  const cursorBoundaries = detail.cursorBoundaries
    ?? (detail.olderCursor && detail.cursorBeforeMessageId
      ? [{ messageId: detail.cursorBeforeMessageId, cursor: detail.olderCursor }]
      : undefined);
  return {
    ...snapshot,
    sessionId: detail.sessionId,
    messages: detail.messages,
    transcriptMessageIndexes: detail.transcriptMessageIndexes,
    taskHistory: detail.taskHistory,
    olderCursor: detail.olderCursor,
    cursorBeforeMessageId: detail.cursorBeforeMessageId,
    cursorBoundaries,
    historyCompleteness: detail.historyCompleteness,
    isStreaming: detail.isStreaming,
    activeTools: detail.activeTools,
    turnActivity: detail.turnActivity,
    taskProgress: detail.taskProgress,
    contextUsage: detail.contextUsage,
  };
}

export function detailFromSnapshot(
  snapshot: HostSnapshot,
  limit = INITIAL_TRANSCRIPT_TURN_LIMIT,
  policy?: TranscriptCursorPolicy<HostTranscriptCursor>,
): ThreadDetail {
  const alreadyBounded = snapshot.messages.length <= limit;
  if (alreadyBounded) return {
    ...threadDetailFromHostSnapshot(snapshot),
    messages: [...snapshot.messages],
    activeTools: [...snapshot.activeTools],
    taskHistory: taskHistoryForMessages(snapshot.taskHistory, snapshot.messages),
    hasMore: snapshot.olderCursor !== undefined,
    historyCompleteness: resolveTranscriptHistoryCompleteness(
      snapshot.historyCompleteness,
      snapshot.olderCursor !== undefined,
    ),
  };
  if (!policy) throw new Error("A host transcript cursor policy is required to bound a full snapshot.");
  const page = TranscriptPager.pageFor(
    snapshot.sessionId,
    snapshot.messages,
    limit,
    undefined,
    policy,
  );
  const boundedWithoutPaging = snapshot.historyCompleteness === "legacy-truncated"
    || snapshot.historyCompleteness === "unknown";
  const olderCursor = boundedWithoutPaging ? undefined : page.olderCursor;
  const transcriptMessageIndexes = projectRawIndexesByMessageId(
    page.messages,
    messageIdToRawIndexProjection(snapshot.messages, snapshot.transcriptMessageIndexes),
  );
  const firstUserMessage = page.messages.find((message) => message.role === "user");
  return {
    sessionId: snapshot.sessionId,
    messages: page.messages,
    ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : {}),
    isStreaming: snapshot.isStreaming,
    activeTools: [...snapshot.activeTools],
    turnActivity: snapshot.turnActivity,
    taskProgress: snapshot.taskProgress,
    taskHistory: taskHistoryForMessages(snapshot.taskHistory, page.messages),
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
  };
}

export function catalogFromSnapshot(snapshot: HostSnapshot): HostCatalog {
  return {
    models: [...snapshot.models],
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    thinkingLevels: [...snapshot.thinkingLevels],
    serviceTier: snapshot.serviceTier,
    serviceTierAvailable: snapshot.serviceTierAvailable,
    allTools: [...snapshot.allTools],
    composerCommands: snapshot.composerCommands?.map((command) => ({ ...command })),
    extensionCount: snapshot.extensionCount,
  };
}
