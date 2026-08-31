import type { UiMessage, UiTaskProgressEntry } from "./contracts.js";
import type { TranscriptHistoryCompleteness } from "./transcript-completeness.js";
import type { TranscriptCursor } from "./transcript-cursor.js";

/**
 * Records shared by transcript details, history pages, and bridge payloads.
 * The message and mapping types stay generic so a bridge can transport its
 * raw records without pretending they are already renderer messages.
 */
export interface TranscriptBundle<TMessage = UiMessage, TMapping = number[], TCursor extends TranscriptCursor | string = TranscriptCursor> {
  messages: TMessage[];
  transcriptMessageIndexes?: TMapping;
  taskHistory?: UiTaskProgressEntry[];
  olderCursor?: TCursor;
  /** Whether the source proves the visible window is complete. */
  historyCompleteness?: TranscriptHistoryCompleteness;
}

/** A bounded page with the cursor needed to request its older records. */
export interface TranscriptPageBundle<TMessage = UiMessage, TMapping = number[], TCursor extends TranscriptCursor | string = TranscriptCursor>
  extends TranscriptBundle<TMessage, TMapping, TCursor> {
  hasMore: boolean;
}

/** A page whose records belong to one visible thread. */
export type ThreadTranscriptPage<TMessage = UiMessage, TMapping = number[], TCursor extends TranscriptCursor | string = TranscriptCursor> =
  TranscriptPageBundle<TMessage, TMapping, TCursor> & { sessionId: string };
