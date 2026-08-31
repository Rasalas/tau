import type { UiMessage, UiTaskProgressEntry } from "../shared/contracts";
import type { ThreadDetail } from "../shared/host-protocol";
import { mergeProjectedRawIndexes } from "../shared/transcript-indexes";
import type {
  TranscriptAnchorRestoreResult,
  TranscriptScrollAnchor,
} from "./transcript-history-types";

export interface TranscriptBundleMergeInput {
  messages: readonly UiMessage[];
  transcriptMessageIndexes?: readonly number[];
  taskHistory?: readonly UiTaskProgressEntry[];
}

export interface TranscriptBundleMergeResult {
  messages: UiMessage[];
  transcriptMessageIndexes?: number[];
  taskHistory?: UiTaskProgressEntry[];
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
  return {
    messages,
    ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : {}),
    ...(taskHistory ? { taskHistory } : {}),
  };
}

export function retainsLoadedHistory(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): current is ThreadDetail {
  if (!current || current.sessionId !== incoming.sessionId || current.messages.length <= incoming.messages.length || incoming.messages.length === 0) return false;
  const currentIds = new Set(current.messages.map((message) => message.id));
  return incoming.messages.some((message) => currentIds.has(message.id));
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
