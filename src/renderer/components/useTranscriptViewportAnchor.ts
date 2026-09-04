import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { RowViewportKeeper, transcriptRows } from "./transcript-scroll-controller";

interface TranscriptVirtualizer {
  measureElement: (element: HTMLElement) => void;
}

interface UseTranscriptViewportAnchorOptions {
  expandedMessageIds: ReadonlySet<string>;
  messageIndexes: MutableRefObject<Map<string, number>>;
  onExpandedChange: (messageId: string, expanded: boolean) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sessionKey: string;
  virtualizer: TranscriptVirtualizer;
}

/**
 * Expanding a message changes one row's height after an asynchronous
 * measurement. The keeper holds the reading position across that gap.
 */
export function useTranscriptViewportAnchor({
  expandedMessageIds,
  messageIndexes,
  onExpandedChange,
  scrollRef,
  sessionKey,
  virtualizer,
}: UseTranscriptViewportAnchorOptions) {
  const [keeper] = useState(() => new RowViewportKeeper());
  const latest = useRef({ scrollRef, virtualizer, onExpandedChange });
  useLayoutEffect(() => { latest.current = { scrollRef, virtualizer, onExpandedChange }; });

  useEffect(() => () => keeper.cancel(), [keeper]);

  useLayoutEffect(() => {
    const token = keeper.token;
    const row = keeper.position?.tracked;
    if (token === undefined || !row?.isConnected) {
      keeper.cancel();
      return;
    }
    const trackedHeight = keeper.position!.trackedHeight;
    const settleAt = (measuredHeight: number) => {
      if (measuredHeight === trackedHeight) keeper.settle(token);
      else keeper.queueRestore(token);
    };
    if (typeof ResizeObserver === "undefined") {
      latest.current.virtualizer.measureElement(row);
      settleAt(row.offsetHeight);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === row);
      if (!entry) return;
      if (keeper.token !== token) {
        observer.disconnect();
        return;
      }
      settleAt(entry.borderBoxSize[0]?.blockSize ?? row.offsetHeight);
    });
    observer.observe(row, { box: "border-box" });
    return () => observer.disconnect();
  }, [expandedMessageIds, keeper]);

  useLayoutEffect(() => { keeper.cancel(); }, [keeper, sessionKey]);

  return useCallback((messageId: string, expanded: boolean) => {
    const container = latest.current.scrollRef.current;
    const messageIndex = messageIndexes.current.get(messageId);
    const previous = keeper.position;
    const tracked = container && messageIndex !== undefined
      ? transcriptRows(container).find((row) => row.dataset.index === String(messageIndex))
      : undefined;
    if (!container || !tracked) keeper.cancel();
    else {
      // A rapid re-toggle of the same row must keep the geometry from before
      // the first change, not the half-applied state it is looking at now.
      const reusable = previous?.tracked === tracked
        && previous.container === container
        && previous.scrollTop === container.scrollTop;
      keeper.capture(container, tracked, reusable ? previous : undefined);
      keeper.guardInteraction(container);
    }
    latest.current.onExpandedChange(messageId, expanded);
  }, [keeper, messageIndexes]);
}
