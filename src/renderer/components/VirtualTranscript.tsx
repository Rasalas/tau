import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useMemo, useRef, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Message } from "./Message";
import {
  groupTranscriptActivitiesForMessageIds,
  unanchoredTranscriptActivitiesForMessageCount,
  type TranscriptActivity,
} from "./transcript-activity";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  activities?: readonly TranscriptActivity[];
  activeTurnStartId?: string;
  /** Changes only when the ordered message ID set changes (not on deltas). */
  messageScopeKey?: string;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}

/** Variable-height transcript window. Activities live inside stable message rows so indexes never shift mid-run. */
export const VirtualTranscript = memo(function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  activities = [],
  activeTurnStartId,
  messageScopeKey,
  onCopyMessage,
  onForkMessage,
}: VirtualTranscriptProps) {
  const indexRef = useRef<{
    scopeKey?: string;
    length: number;
    firstId?: string;
    lastId?: string;
    ids: Set<string>;
    positions: Map<string, number>;
    version: number;
  } | undefined>(undefined);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  const currentIndex = indexRef.current;
  if (!currentIndex
    || currentIndex.scopeKey !== messageScopeKey
    || currentIndex.length !== messages.length
    || currentIndex.firstId !== firstId
    || currentIndex.lastId !== lastId) {
    const ids = new Set<string>();
    const positions = new Map<string, number>();
    messages.forEach((message, index) => {
      ids.add(message.id);
      positions.set(message.id, index);
    });
    indexRef.current = {
      scopeKey: messageScopeKey,
      length: messages.length,
      firstId,
      lastId,
      ids,
      positions,
      version: (currentIndex?.version ?? 0) + 1,
    };
  }
  const messageIndex = indexRef.current!;
  const activitiesByMessage = useMemo(
    () => groupTranscriptActivitiesForMessageIds(messageIndex.ids, messageIndex.lastId, activities),
    [activities, messageIndex.version],
  );
  const unanchoredActivities = useMemo(
    () => unanchoredTranscriptActivitiesForMessageCount(messageIndex.length, activities),
    [activities, messageIndex.version],
  );
  const activeTurnStartIndex = useMemo(
    () => activeTurnStartId === undefined
      ? -1
      : messageIndex.positions.get(activeTurnStartId) ?? -1,
    [activeTurnStartId, messageIndex.version],
  );

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messages[index]?.id ?? index,
    initialRect: { width: 780, height: 600 },
    // Keep the initial/current-turn window small enough that long active turns
    // remain bounded without paying for a large hidden DOM on every update.
    overscan: 3,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length > 0
    ? measuredRows
    : messages.slice(0, 12).map((message, index) => ({ index, key: message.id, start: index * 180 }));

  if (messages.length === 0 && unanchoredActivities.length > 0) {
    return <div className="virtual-transcript static-activity-transcript">
      {unanchoredActivities.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
    </div>;
  }

  return <div
    className="virtual-transcript"
    style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
  >
    {rows.map((row) => {
      const message = messages[row.index];
      const anchoredActivities = activitiesByMessage.get(message.id) ?? [];
      return <div
        key={message.id}
        ref={virtualizer.measureElement}
        data-index={row.index}
        data-message-id={message.id}
        className={[
          "virtual-transcript-row",
          activeTurnStartIndex >= 0 && row.index >= activeTurnStartIndex ? "transcript-current-row" : "",
        ].filter(Boolean).join(" ")}
        style={{
          position: "absolute",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${row.start}px)`,
        }}
      >
        <Message
          message={message}
          streaming={Boolean(isStreaming && message === messages.at(-1) && message.role === "assistant")}
          onCopy={onCopyMessage}
          onFork={onForkMessage}
        />
        {anchoredActivities.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
      </div>;
    })}
  </div>;
});
