import type { UiMessage, UiTaskProgressEntry } from "./contracts.js";

/**
 * Records shared by transcript details, history pages, and bridge payloads.
 * The message and mapping types stay generic so a bridge can transport its
 * raw records without pretending they are already renderer messages.
 */
export interface TranscriptBundle<TMessage = UiMessage, TMapping = number[]> {
  messages: TMessage[];
  transcriptMessageIndexes?: TMapping;
  taskHistory?: UiTaskProgressEntry[];
  olderCursor?: string;
}

/** A bounded page with the cursor needed to request its older records. */
export interface TranscriptPageBundle<TMessage = UiMessage, TMapping = number[]>
  extends TranscriptBundle<TMessage, TMapping> {
  hasMore: boolean;
}

/** A page whose records belong to one visible thread. */
export type ThreadTranscriptPage<TMessage = UiMessage, TMapping = number[]> =
  TranscriptPageBundle<TMessage, TMapping> & { sessionId: string };
