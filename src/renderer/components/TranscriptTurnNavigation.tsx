import type { TranscriptTurnNavigationEntry } from "./transcript-turn-navigation";

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
        {entries.map((entry) => {
          const active = entry.messageId === activeMessageId;
          return (
            <li key={entry.messageId}>
              <button
                type="button"
                className={active ? "active" : undefined}
                aria-current={active ? "true" : undefined}
                aria-label={`Go to turn ${entry.turnNumber}: ${entry.preview || "Image attachment"}`}
                title={entry.preview || "Image attachment"}
                onClick={() => onSelect(entry.messageId)}
              >
                <span className="transcript-turn-number" aria-hidden="true">{entry.turnNumber}</span>
                <span className="transcript-turn-preview">{entry.preview || "Image attachment"}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
