import type { UiMessage, UiTaskProgressEntry, UiTurnActivityEntry } from "../shared/contracts.js";
import type { ThreadDetail } from "../shared/host-protocol.js";
import type { TranscriptCursorBoundary } from "../shared/transcript-contract.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type {
  TranscriptAnchorRestoreResult,
  TranscriptScrollAnchor,
} from "./transcript-history-types.js";

export interface TranscriptBundleMergeInput {
  messages: readonly UiMessage[];
  taskHistory?: readonly UiTaskProgressEntry[];
  turnActivityHistory?: readonly UiTurnActivityEntry[];
  cursorBoundaries?: readonly TranscriptCursorBoundary<HostTranscriptCursor>[];
  transcriptWindow?: "bounded";
}

export interface TranscriptBundleMergeResult {
  messages: UiMessage[];
  taskHistory?: UiTaskProgressEntry[];
  turnActivityHistory?: UiTurnActivityEntry[];
  cursorBoundaries?: TranscriptCursorBoundary<HostTranscriptCursor>[];
  transcriptWindow?: "bounded";
}

function mergeCursorBoundaries(
  current: readonly TranscriptCursorBoundary<HostTranscriptCursor>[] | undefined,
  incoming: readonly TranscriptCursorBoundary<HostTranscriptCursor>[] | undefined,
): TranscriptCursorBoundary<HostTranscriptCursor>[] | undefined {
  if (!current && !incoming) return undefined;
  const byMessageId = new Map<string, TranscriptCursorBoundary<HostTranscriptCursor>>();
  for (const boundary of current ?? []) byMessageId.set(boundary.messageId, boundary);
  // A boundary already present in the loaded window is the coordinate that
  // produced that window. Keep it when a same-thread refresh supplies a newer
  // tail snapshot; replacing it would pair the preserved older cursor with a
  // different opaque coordinate and could skip history on the next request.
  for (const boundary of incoming ?? []) {
    if (!byMessageId.has(boundary.messageId)) byMessageId.set(boundary.messageId, boundary);
  }
  return [...byMessageId.values()];
}

export function mergeTranscriptMessages(
  current: readonly UiMessage[],
  incoming: readonly UiMessage[],
  position: "prepend" | "append" = "append",
): UiMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message] as const));
  const retainedIds = new Set<string>();
  const retained = current.flatMap((message) => {
    if (retainedIds.has(message.id)) return [];
    retainedIds.add(message.id);
    return [incomingById.get(message.id) ?? message];
  });
  const additionIds = new Set<string>();
  const additions = incoming.flatMap((message) => {
    if (retainedIds.has(message.id) || additionIds.has(message.id)) return [];
    additionIds.add(message.id);
    return [incomingById.get(message.id) ?? message];
  });
  return position === "prepend" ? [...additions, ...retained] : [...retained, ...additions];
}

export function mergeTaskHistory(
  current: readonly UiTaskProgressEntry[] | undefined,
  incoming: readonly UiTaskProgressEntry[] | undefined,
): UiTaskProgressEntry[] | undefined {
  if (!current && !incoming) return undefined;
  const byId = new Map<string, UiTaskProgressEntry>();
  for (const entry of current ?? []) byId.set(entry.id, entry);
  for (const entry of incoming ?? []) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function mergeTurnActivityHistory(
  current: readonly UiTurnActivityEntry[] | undefined,
  incoming: readonly UiTurnActivityEntry[] | undefined,
): UiTurnActivityEntry[] | undefined {
  if (!current && !incoming) return undefined;
  const byId = new Map<string, UiTurnActivityEntry>();
  for (const entry of current ?? []) byId.set(entry.id, entry);
  for (const entry of incoming ?? []) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => {
    const leftStart = left.tools[0]?.startedAt ?? Number.POSITIVE_INFINITY;
    const rightStart = right.tools[0]?.startedAt ?? Number.POSITIVE_INFINITY;
    return leftStart - rightStart || left.id.localeCompare(right.id);
  });
}

/** Apply one transcript bundle merge policy across detail, page, and snapshot paths. */
export function applyTranscriptBundleMerge(
  current: TranscriptBundleMergeInput | undefined,
  incoming: TranscriptBundleMergeInput,
  position: "prepend" | "append" = "append",
): TranscriptBundleMergeResult {
  if (!current) {
    return {
      messages: [...incoming.messages],
      ...(incoming.taskHistory ? { taskHistory: [...incoming.taskHistory] } : {}),
      ...(incoming.turnActivityHistory ? { turnActivityHistory: [...incoming.turnActivityHistory] } : {}),
      ...(incoming.cursorBoundaries ? { cursorBoundaries: [...incoming.cursorBoundaries] } : {}),
      ...(incoming.transcriptWindow ? { transcriptWindow: incoming.transcriptWindow } : {}),
    };
  }
  const messages = mergeTranscriptMessages(current.messages, incoming.messages, position);
  const taskHistory = mergeTaskHistory(current.taskHistory, incoming.taskHistory);
  const turnActivityHistory = mergeTurnActivityHistory(current.turnActivityHistory, incoming.turnActivityHistory);
  const cursorBoundaries = mergeCursorBoundaries(current.cursorBoundaries, incoming.cursorBoundaries);
  const transcriptWindow = incoming.transcriptWindow ?? current.transcriptWindow;
  return {
    messages,
    ...(taskHistory ? { taskHistory } : {}),
    ...(turnActivityHistory ? { turnActivityHistory } : {}),
    ...(cursorBoundaries ? { cursorBoundaries } : {}),
    ...(transcriptWindow ? { transcriptWindow } : {}),
  };
}

export function retainsLoadedHistory(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): current is ThreadDetail {
  if (!current || current.sessionId !== incoming.sessionId || current.messages.length === 0 || incoming.messages.length === 0) return false;
  const currentPositions = new Map(current.messages.map((message, index) => [message.id, index] as const));
  let incomingStart = -1;
  let currentStart = -1;
  let overlapLength = 0;
  let gapAfterOverlap = false;
  for (let incomingIndex = 0; incomingIndex < incoming.messages.length; incomingIndex += 1) {
    const message = incoming.messages[incomingIndex];
    const currentIndex = currentPositions.get(message?.id);
    if (currentIndex === undefined) {
      // Unknown records before an overlap are acceptable only when no
      // overlap is ultimately found (the final prefix check rejects that
      // case). Once the contiguous overlap has started, an unknown record
      // marks the incoming newer tail; another old id after that tail would
      // make the two windows non-contiguous.
      if (overlapLength > 0) gapAfterOverlap = true;
      continue;
    }
    if (gapAfterOverlap) return false;
    if (overlapLength === 0) {
      incomingStart = incomingIndex;
      currentStart = currentIndex;
    } else if (
      incomingIndex !== incomingStart + overlapLength
      || currentIndex !== currentStart + overlapLength
    ) {
      return false;
    }
    overlapLength += 1;
  }
  return overlapLength > 0
    && incomingStart === 0
    && currentStart + overlapLength === current.messages.length;
}

function messageRows(node: HTMLDivElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"));
}

export function captureTranscriptScrollAnchor(node: HTMLDivElement): TranscriptScrollAnchor | undefined {
  const rows = messageRows(node);
  if (rows.length === 0) return undefined;
  const viewport = node.getBoundingClientRect();
  const visible = rows.find((row) => {
    const rowRect = row.getBoundingClientRect();
    return rowRect.bottom > viewport.top && rowRect.top < viewport.bottom;
  })
    ?? rows[0];
  const rect = visible.getBoundingClientRect();
  return {
    messageId: visible.dataset.messageId ?? "",
    viewportOffset: rect.top - viewport.top,
  };
}

export function restoreTranscriptScrollAnchor(
  node: Pick<HTMLDivElement, "scrollTop" | "getBoundingClientRect" | "querySelectorAll">,
  anchor: TranscriptScrollAnchor,
): TranscriptAnchorRestoreResult {
  const row = Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === anchor.messageId);
  if (!row) return { found: false, delta: 0 };
  const viewport = node.getBoundingClientRect();
  const delta = row.getBoundingClientRect().top - viewport.top - anchor.viewportOffset;
  if (Math.abs(delta) > 0.5) node.scrollTop += delta;
  return { found: true, delta };
}

/** Owns the short-lived prepend anchor lease and the merge helpers' UI state. */
export class TranscriptHistoryPageState {
  readonly preserveScrollRef: { current: boolean | undefined } = { current: undefined };
  readonly anchorRef: { current: TranscriptScrollAnchor | undefined } = { current: undefined };

  beginPaging(anchor: TranscriptScrollAnchor | undefined): void {
    this.anchorRef.current = anchor;
    this.preserveScrollRef.current = true;
  }

  markAnchorMeasured(messages: readonly UiMessage[]): void {
    const anchor = this.anchorRef.current;
    if (!anchor || anchor.measureThrough !== undefined) return;
    const anchorIndex = messages.findIndex((message) => message.id === anchor.messageId);
    if (anchorIndex >= 0) this.anchorRef.current = { ...anchor, measureThrough: anchorIndex + 1 };
  }

  leaseForThreadState(preserveAnchor: boolean): {
    anchor?: TranscriptScrollAnchor;
    preserveScroll?: boolean;
  } {
    return preserveAnchor
      ? { anchor: this.anchorRef.current, preserveScroll: this.preserveScrollRef.current }
      : {};
  }

  restoreLease(lease: { anchor?: TranscriptScrollAnchor; preserveScroll?: boolean }): void {
    this.anchorRef.current = lease.anchor;
    this.preserveScrollRef.current = lease.preserveScroll;
  }

  finishPaging(): void {
    if (!this.anchorRef.current) this.preserveScrollRef.current = undefined;
  }

  release(): boolean {
    if (!this.anchorRef.current && this.preserveScrollRef.current === undefined) return false;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    return true;
  }

  clear(): void {
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
  }
}
