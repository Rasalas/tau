import type { UiMessage, UiTaskProgressEntry } from "./contracts.js";
import type { TranscriptHistoryCompleteness } from "./transcript-completeness.js";
import type { HostTranscriptCursor } from "./transcript-cursor.js";

export interface TranscriptCursorBoundary<TCursor extends string = HostTranscriptCursor> {
  messageId: string;
  cursor: TCursor;
}

/**
 * Records shared by transcript details, history pages, and bridge payloads.
 * The message and mapping types stay generic so a bridge can transport its
 * raw records without pretending they are already renderer messages.
 */
export interface TranscriptBundle<TMessage = UiMessage, TMapping = number[], TCursor extends string = HostTranscriptCursor> {
  messages: TMessage[];
  transcriptMessageIndexes?: TMapping;
  taskHistory?: UiTaskProgressEntry[];
  /** Opaque host-owned cursor for the next older page. */
  olderCursor?: TCursor;
  /** Message at the beginning of the current bounded window. */
  cursorBeforeMessageId?: string;
  /** Opaque cursors retained for previously loaded page boundaries. */
  cursorBoundaries?: Array<TranscriptCursorBoundary<TCursor>>;
  /** Whether the source proves the visible window is complete. */
  historyCompleteness?: TranscriptHistoryCompleteness;
}

/** A bounded page with the cursor needed to request its older records. */
export interface TranscriptPageBundle<TMessage = UiMessage, TMapping = number[], TCursor extends string = HostTranscriptCursor>
  extends TranscriptBundle<TMessage, TMapping, TCursor> {
  hasMore: boolean;
}

/** A page whose records belong to one visible thread. */
export type ThreadTranscriptPage<TMessage = UiMessage, TMapping = number[], TCursor extends string = HostTranscriptCursor> =
  TranscriptPageBundle<TMessage, TMapping, TCursor> & { sessionId: string };
