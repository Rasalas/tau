import type { UiMessage, UiTaskProgressEntry } from "../shared/contracts";
import type { ThreadDetail } from "../shared/host-protocol";
import type { TranscriptCursorBoundary } from "../shared/transcript-contract";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { mergeProjectedRawIndexes } from "../shared/transcript-indexes";
import type {
  TranscriptAnchorRestoreResult,
  TranscriptScrollAnchor,
} from "./transcript-history-types";

export interface TranscriptBundleMergeInput {
  messages: readonly UiMessage[];
  transcriptMessageIndexes?: readonly number[];
  taskHistory?: readonly UiTaskProgressEntry[];
  cursorBoundaries?: readonly TranscriptCursorBoundary<HostTranscriptCursor>[];
}

export interface TranscriptBundleMergeResult {
  messages: UiMessage[];
  transcriptMessageIndexes?: number[];
  taskHistory?: UiTaskProgressEntry[];
  cursorBoundaries?: TranscriptCursorBoundary<HostTranscriptCursor>[];
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

/** Apply one transcript bundle merge policy across detail, page, and snapshot paths. */
export function applyTranscriptBundleMerge(
  current: TranscriptBundleMergeInput | undefined,
  incoming: TranscriptBundleMergeInput,
  position: "prepend" | "append" = "append",
): TranscriptBundleMergeResult {
  if (!current) {
    return {
      messages: [...incoming.messages],
      ...(incoming.transcriptMessageIndexes ? { transcriptMessageIndexes: [...incoming.transcriptMessageIndexes] } : {}),
      ...(incoming.taskHistory ? { taskHistory: [...incoming.taskHistory] } : {}),
      ...(incoming.cursorBoundaries ? { cursorBoundaries: [...incoming.cursorBoundaries] } : {}),
    };
  }
  const messages = mergeTranscriptMessages(current.messages, incoming.messages, position);
  const transcriptMessageIndexes = mergeProjectedRawIndexes(
    current.messages,
    current.transcriptMessageIndexes,
    incoming.messages,
    incoming.transcriptMessageIndexes,
    messages,
  );
  const taskHistory = mergeTaskHistory(current.taskHistory, incoming.taskHistory);
  const cursorBoundaries = mergeCursorBoundaries(current.cursorBoundaries, incoming.cursorBoundaries);
  return {
    messages,
    ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : {}),
    ...(taskHistory ? { taskHistory } : {}),
    ...(cursorBoundaries ? { cursorBoundaries } : {}),
  };
}

export function retainsLoadedHistory(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): current is ThreadDetail {
  if (!current || current.sessionId !== incoming.sessionId || current.messages.length === 0 || incoming.messages.length === 0) return false;
  const currentPositions = new Map(current.messages.map((message, index) => [message.id, index] as const));
  let previousPosition = -1;
  let overlap = false;
  for (const message of incoming.messages) {
    const position = currentPositions.get(message.id);
    if (position === undefined) continue;
    overlap = true;
    if (position < previousPosition) return false;
    previousPosition = position;
  }
  if (overlap) return true;

  // IDs can be absent or regenerated by an adapter. Raw-index projections are
  // the only safe fallback for deciding that two windows are adjacent rather
  // than unrelated histories.
  const currentIndexes = current.transcriptMessageIndexes;
  const incomingIndexes = incoming.transcriptMessageIndexes;
  if (!currentIndexes || !incomingIndexes || currentIndexes.length === 0 || incomingIndexes.length === 0) return false;
  if (currentIndexes.length !== current.messages.length || incomingIndexes.length !== incoming.messages.length) return false;
  const currentStart = Math.min(...currentIndexes);
  const currentEnd = Math.max(...currentIndexes);
  const incomingStart = Math.min(...incomingIndexes);
  const incomingEnd = Math.max(...incomingIndexes);
  const currentIndexSet = new Set(currentIndexes);
  const overlaps = incomingIndexes.some((index) => currentIndexSet.has(index));
  const touches = incomingStart === currentEnd + 1 || currentStart === incomingEnd + 1;
  return overlaps || touches;
}

export const mergeTranscriptMessageIndexes = mergeProjectedRawIndexes;

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
