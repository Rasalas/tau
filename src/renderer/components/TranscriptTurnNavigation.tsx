import { useCallback, useState, type MouseEvent } from "react";
import {
  transcriptTurnNavigationHeight,
  transcriptTurnNavigationIndexFromPointer,
  transcriptTurnNavigationMarkerIndexes,
  transcriptTurnNavigationTopPercent,
  type TranscriptTurnNavigationEntry,
} from "./transcript-turn-navigation";

export interface TranscriptTurnNavigationProps {
  entries: readonly TranscriptTurnNavigationEntry[];
  activeMessageId?: string;
  transcriptId: string;
  onSelect: (messageId: string) => void;
}

/** A compact timeline minimap for the loaded user turns. */
export function TranscriptTurnNavigation({
  entries,
  activeMessageId,
  transcriptId,
  onSelect,
}: TranscriptTurnNavigationProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const activeIndex = entries.findIndex((entry) => entry.messageId === activeMessageId);
  const resolvedHoveredIndex = hoveredIndex !== null && hoveredIndex < entries.length
    ? hoveredIndex
    : null;
  const hoveredEntry = resolvedHoveredIndex === null ? undefined : entries[resolvedHoveredIndex];
  const markerIndexes = transcriptTurnNavigationMarkerIndexes(entries.length);

  const indexFromPointer = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return transcriptTurnNavigationIndexFromPointer({
      entryCount: entries.length,
      railTop: bounds.top,
      railHeight: bounds.height,
      pointerY: event.clientY,
    });
  }, [entries.length]);

  const moveHoveredTurn = useCallback((delta: number) => {
    setHoveredIndex((current) => {
      const initial = activeIndex >= 0 ? activeIndex : 0;
      return Math.max(0, Math.min(entries.length - 1, (current ?? initial) + delta));
    });
  }, [activeIndex, entries.length]);

  const hoveredTop = resolvedHoveredIndex === null
    ? 0
    : transcriptTurnNavigationTopPercent(resolvedHoveredIndex, entries.length);
  const tooltipTranslate = resolvedHoveredIndex === 0
    ? "0%"
    : resolvedHoveredIndex === entries.length - 1
      ? "-100%"
      : "-50%";

  return (
    <nav
      className="transcript-turn-navigation"
      aria-label="Transcript turns"
      aria-controls={transcriptId}
    >
      <button
        type="button"
        className="transcript-turn-navigation-rail"
        aria-label={`Jump to turn: ${hoveredEntry?.preview || "User message"}`}
        onBlur={() => setHoveredIndex(null)}
        onClick={(event) => {
          const index = indexFromPointer(event);
          if (index !== null) onSelect(entries[index]!.messageId);
          event.currentTarget.blur();
        }}
        onFocus={() => setHoveredIndex((current) => current ?? (activeIndex >= 0 ? activeIndex : 0))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveHoveredTurn(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveHoveredTurn(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            setHoveredIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            setHoveredIndex(entries.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (hoveredEntry) onSelect(hoveredEntry.messageId);
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        onMouseLeave={() => setHoveredIndex(null)}
        onMouseMove={(event) => setHoveredIndex(indexFromPointer(event))}
        style={{ height: transcriptTurnNavigationHeight(entries.length) }}
      >
        <span className="transcript-turn-navigation-spine" aria-hidden="true" />
        {markerIndexes.map((entryIndex) => {
          const distance = resolvedHoveredIndex === null
            ? null
            : Math.abs(entryIndex - resolvedHoveredIndex);
          return (
            <span
              key={entries[entryIndex]!.messageId}
              className="transcript-turn-navigation-marker"
              data-distance={distance !== null && distance <= 2 ? String(distance) : undefined}
              aria-hidden="true"
              style={{ top: `${transcriptTurnNavigationTopPercent(entryIndex, entries.length)}%` }}
            />
          );
        })}
        {activeIndex >= 0 ? (
          <span
            className="transcript-turn-navigation-current"
            aria-hidden="true"
            style={{ top: `${transcriptTurnNavigationTopPercent(activeIndex, entries.length)}%` }}
          />
        ) : null}
        {hoveredEntry ? (
          <span
            className="transcript-turn-navigation-preview"
            style={{ top: `${hoveredTop}%`, transform: `translateY(${tooltipTranslate})` }}
          >
            <span className="transcript-turn-navigation-preview-number">Turn {hoveredEntry.turnNumber}</span>
            <span className="transcript-turn-navigation-preview-text">{hoveredEntry.preview || "Image attachment"}</span>
          </span>
        ) : null}
      </button>
    </nav>
  );
}
