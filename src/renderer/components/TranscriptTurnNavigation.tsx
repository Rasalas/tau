import { useEffect, useState } from "react";
import {
  TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE,
  type TranscriptTurnNavigationEntry,
} from "./transcript-turn-navigation";

export interface TranscriptTurnNavigationProps {
  entries: readonly TranscriptTurnNavigationEntry[];
  activeMessageId?: string;
  transcriptId: string;
  onSelect: (messageId: string) => void;
}

/** A compact, keyboard-friendly index for the loaded user turns. */
export function TranscriptTurnNavigation({
  entries,
  activeMessageId,
  transcriptId,
  onSelect,
}: TranscriptTurnNavigationProps) {
  const pageCount = Math.max(1, Math.ceil(entries.length / TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE));
  const activeIndex = entries.findIndex((entry) => entry.messageId === activeMessageId);
  const activePage = activeIndex >= 0
    ? Math.floor(activeIndex / TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE)
    : 0;
  const [page, setPage] = useState(activePage);
  const visiblePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    setPage((current) => current === activePage ? current : activePage);
  }, [activePage]);

  const pageStart = visiblePage * TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE;
  const pageEntries = entries.slice(pageStart, pageStart + TRANSCRIPT_TURN_NAVIGATION_PAGE_SIZE);
  const hasPages = pageCount > 1;

  return (
    <nav
      className="transcript-turn-navigation"
      aria-label="Transcript turns"
      aria-controls={transcriptId}
    >
      <div className="transcript-turn-navigation-heading">
        <span>Turns</span>
        <small>{entries.length}</small>
      </div>
      <ol className="transcript-turn-navigation-list">
        {pageEntries.map((entry) => {
          const active = entry.messageId === activeMessageId;
          return (
            <li
              key={entry.messageId}
              data-turn-navigation-entry="true"
              aria-setsize={entries.length}
              aria-posinset={entry.turnNumber}
            >
              <button
                type="button"
                className={active ? "active" : undefined}
                aria-current={active ? "true" : undefined}
                aria-label={`Go to turn ${entry.turnNumber}: ${entry.preview || "Image attachment"}`}
                title={entry.preview || "Image attachment"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  // Keep keyboard activation deterministic in browsers and
                  // test environments while avoiding a second native click.
                  event.preventDefault();
                  onSelect(entry.messageId);
                }}
                onClick={() => onSelect(entry.messageId)}
              >
                <span className="transcript-turn-number" aria-hidden="true">{entry.turnNumber}</span>
                <span className="transcript-turn-preview">{entry.preview || "Image attachment"}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {hasPages ? (
        <div className="transcript-turn-navigation-pager" role="group" aria-label="Turn pages">
          <button
            type="button"
            aria-label="Previous turn page"
            title="Previous turn page"
            disabled={visiblePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            ‹
          </button>
          <span aria-live="polite">
            Turns {pageStart + 1}–{Math.min(pageStart + pageEntries.length, entries.length)} of {entries.length}
          </span>
          <button
            type="button"
            aria-label="Next turn page"
            title="Next turn page"
            disabled={visiblePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            ›
          </button>
        </div>
      ) : null}
    </nav>
  );
}
