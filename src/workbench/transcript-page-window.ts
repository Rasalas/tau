import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import type { UiMessage } from "../shared/contracts";
import { transcriptRetainedBytes } from "../shared/transcript-memory";
import { applyTranscriptBundleMerge, retainsLoadedHistory } from "./transcript-history-page-state";

export const TRANSCRIPT_WINDOW_MESSAGES = 1000;
export const TRANSCRIPT_WINDOW_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_WINDOW_PAGES = 8;

/**
 * A backward-reading window plus the live tail. Whole source pages own their
 * metadata and opaque coordinates. Keep the two leading pages even if oversized:
 * the preceding leading row survives a prepend, and no message is truncated.
 * Evicted middle pages are re-read by restarting at the tail, never by deriving
 * a cursor. No list of discarded pages/ids/cursors accumulates here.
 */
export class TranscriptPageWindow {
  private pages: TranscriptPage[] = [];
  private tail?: ThreadDetail;
  private evicted = false;

  reset(detail: ThreadDetail): void {
    this.pages = [];
    this.tail = detail;
    this.evicted = false;
  }

  refresh(detail: ThreadDetail): void {
    const merged = retainsLoadedHistory(this.tail, detail)
      ? {
          ...detail,
          ...applyTranscriptBundleMerge(this.tail, detail),
          olderCursor: this.tail.olderCursor,
          cursorBeforeMessageId: this.tail.cursorBeforeMessageId,
          hasMore: this.tail.hasMore,
          historyCompleteness: this.tail.historyCompleteness,
        }
      : detail;
    const fits = merged.messages.length <= TRANSCRIPT_WINDOW_MESSAGES
      && transcriptRetainedBytes(merged) <= TRANSCRIPT_WINDOW_BYTES;
    const incomingIds = new Set(detail.messages.map((message) => message.id));
    if (!fits && this.pages.length > 0 && merged.messages.some((message) => !incomingIds.has(message.id))) {
      this.evicted = true;
    }
    this.tail = fits ? merged : detail;
  }

  get hasGap(): boolean { return this.evicted; }

  get gapBeforeMessageId(): string | undefined {
    return this.evicted ? this.tail?.messages[0]?.id : undefined;
  }

  get latest(): ThreadDetail | undefined { return this.tail; }

  /** Only prepend for scrolling while the reader is in the leading source page.
   * Tiny pages with large metadata must not evict a visible row further down. */
  canPrependAt(messageId: string): boolean {
    return (this.pages[0] ?? this.tail)?.messages.some((message) => message.id === messageId) ?? false;
  }

  prepend(page: TranscriptPage, visibleMessages: readonly UiMessage[]): ThreadDetail | undefined {
    if (!this.tail) return undefined;
    // Live deltas are owned by ThreadViewStore until a host detail arrives.
    // Move their newest versions into the tail before rebuilding the window.
    const historicalIds = new Set(this.pages.flatMap((entry) => entry.messages.map((message) => message.id)));
    const tailIds = new Set(this.tail.messages.map((message) => message.id));
    const live = visibleMessages.filter((message) => tailIds.has(message.id) || !historicalIds.has(message.id));
    this.tail = { ...this.tail, ...applyTranscriptBundleMerge(this.tail, { messages: live }) };
    // A repeated external page replaces its source bundle instead of holding
    // duplicate pages forever. The cursor is opaque and only compared for equality.
    this.pages = this.pages.filter((entry) => entry.messages[0]?.id !== page.messages[0]?.id);
    this.pages.unshift(page);
    this.trim();
    return this.detail();
  }

  private trim(): void {
    let count = this.pages.reduce((sum, page) => sum + page.messages.length, 0);
    let bytes = this.pages.reduce((sum, page) => sum + transcriptRetainedBytes(page), 0);
    while (this.pages.length > 2 && (this.pages.length > TRANSCRIPT_WINDOW_PAGES
      || count > TRANSCRIPT_WINDOW_MESSAGES || bytes > TRANSCRIPT_WINDOW_BYTES)) {
      const removed = this.pages.pop()!;
      count -= removed.messages.length;
      bytes -= transcriptRetainedBytes(removed);
      this.evicted = true;
    }
  }

  detail(): ThreadDetail | undefined {
    if (!this.tail) return undefined;
    this.trim();
    let bundle = applyTranscriptBundleMerge(undefined, this.tail);
    for (const page of [...this.pages].reverse()) bundle = applyTranscriptBundleMerge(bundle, page, "prepend");
    bundle = applyTranscriptBundleMerge(bundle, this.tail);
    const oldest = this.pages[0] ?? this.tail;
    return {
      ...this.tail,
      ...bundle,
      olderCursor: oldest.olderCursor,
      cursorBeforeMessageId: oldest.cursorBeforeMessageId,
      hasMore: Boolean(oldest.olderCursor),
      historyCompleteness: this.evicted && !oldest.olderCursor ? "unknown" : oldest.historyCompleteness,
    };
  }
}
