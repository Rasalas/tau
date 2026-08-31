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
import {
  localTranscriptCursorAt,
  parseTranscriptCursor,
  rawBridgeTranscriptCursorAt,
  transcriptCursorIndex,
  type TranscriptCoordinateSpace,
  type TranscriptCursor,
} from "./transcript-cursor.js";
import { INITIAL_TRANSCRIPT_TURN_LIMIT, TranscriptPager } from "./transcript-pager.js";

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

export interface ThreadDetail extends TranscriptBundle<UiMessage, number[], TranscriptCursor> {
  sessionId: string;
  isStreaming: boolean;
  activeTools: string[];
  turnActivity?: UiTurnActivity;
  taskProgress?: UiTaskProgress;
  contextUsage?: UiContextUsage;
  /** Whether another page exists; omitted by older protocol peers. */
  hasMore?: boolean;
}

export type TranscriptPage = ThreadTranscriptPage<UiMessage, number[], TranscriptCursor>;

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

function validCoordinateSpace(value: unknown): value is TranscriptCoordinateSpace | undefined {
  return value === undefined || value === "local" || value === "bridge";
}

function validCursor(value: unknown, coordinateSpace?: TranscriptCoordinateSpace): boolean {
  if (value === undefined) return true;
  try { parseTranscriptCursor(value, undefined, coordinateSpace); return true; }
  catch { return false; }
}

function normalizeCursor(value: unknown, coordinateSpace?: TranscriptCoordinateSpace): TranscriptCursor | undefined {
  if (value === undefined) return undefined;
  return parseTranscriptCursor(value, undefined, coordinateSpace);
}

function cursorIndex(cursor: TranscriptCursor, maximum: number, coordinateSpace?: TranscriptCoordinateSpace): number {
  return transcriptCursorIndex(cursor, maximum, coordinateSpace);
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
      && validCoordinateSpace(payload.coordinateSpace)
      && validCursor(payload.olderCursor, payload.coordinateSpace)
      && isTranscriptHistoryMetadataConsistent({
        hasMore: payload.hasMore,
        hasCursor: payload.olderCursor !== undefined,
        historyCompleteness: payload.historyCompleteness,
        requireHasMore: false,
      })
      && validIndexes(payload.transcriptMessageIndexes)
      && (payload.taskHistory === undefined || Array.isArray(payload.taskHistory)));
    case "transcript-page": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.messages) && typeof payload.hasMore === "boolean"
      && validCoordinateSpace(payload.coordinateSpace)
      && validCursor(payload.olderCursor, payload.coordinateSpace)
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
  const coordinateSpace = snapshot.coordinateSpace
    ?? (snapshot.olderCursor?.kind === "bridge" ? "bridge" : "local");
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
    coordinateSpace,
    olderCursor: snapshot.olderCursor,
    hasMore: snapshot.olderCursor !== undefined,
    historyCompleteness: snapshot.historyCompleteness,
  };
}

function cursorForPage(
  page: TranscriptPage,
  snapshot: HostSnapshot,
): TranscriptCursor | undefined {
  const coordinateSpace = snapshot.coordinateSpace
    ?? (typeof snapshot.olderCursor === "object" && snapshot.olderCursor?.kind === "bridge" ? "bridge" : "local");
  const pageCursor = normalizeCursor(page.olderCursor, coordinateSpace);
  const snapshotCursor = normalizeCursor(snapshot.olderCursor, coordinateSpace);
  const messageRawIndexes = snapshot.transcriptMessageIndexes;
  if (!messageRawIndexes) {
    // A bridge cursor cannot be safely represented in the local coordinate
    // space without the raw-index projection. Keep the bridge origin intact
    // until such a mapping is actually available.
    return snapshotCursor?.kind === "bridge"
      ? snapshotCursor
      : pageCursor ?? snapshotCursor;
  }
  if (pageCursor === undefined) return snapshotCursor;
  const localStart = cursorIndex(
    pageCursor,
    pageCursor.kind === "local" ? snapshot.messages.length : Number.MAX_SAFE_INTEGER,
    coordinateSpace,
  );
  const index = messageRawIndexes[localStart];
  if (index === undefined || index <= 0) return snapshotCursor;
  return coordinateSpace === "bridge"
    ? rawBridgeTranscriptCursorAt(index)
    : localTranscriptCursorAt(index);
}

export function detailFromSnapshot(snapshot: HostSnapshot, limit = INITIAL_TRANSCRIPT_TURN_LIMIT): ThreadDetail {
  const coordinateSpace = snapshot.coordinateSpace
    ?? (typeof snapshot.olderCursor === "object" && snapshot.olderCursor?.kind === "bridge" ? "bridge" : "local");
  const cursorAt = (index: number): TranscriptCursor => coordinateSpace === "bridge"
    ? rawBridgeTranscriptCursorAt(index)
    : localTranscriptCursorAt(index);
  const page = TranscriptPager.pageFor(
    snapshot.sessionId,
    snapshot.messages,
    limit,
    undefined,
    cursorAt,
  );
  const boundedWithoutPaging = snapshot.historyCompleteness === "legacy-truncated"
    || snapshot.historyCompleteness === "unknown";
  const olderCursor = boundedWithoutPaging ? undefined : cursorForPage(page, snapshot);
  const transcriptMessageIndexes = projectRawIndexesByMessageId(
    page.messages,
    messageIdToRawIndexProjection(snapshot.messages, snapshot.transcriptMessageIndexes),
  );
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
    coordinateSpace,
    ...(olderCursor ? { olderCursor } : {}),
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
