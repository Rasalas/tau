import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptScrollAnchor } from "../transcript-history";
import { Message } from "./Message";
import {
  groupTranscriptActivitiesForMessageIds,
  unanchoredTranscriptActivitiesForMessageCount,
  type TranscriptActivity,
} from "./transcript-activity";
import { useTranscriptViewportAnchor } from "./useTranscriptViewportAnchor";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  sessionKey?: string;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: readonly TranscriptActivity[];
  activeTurnStartId?: string;
  /** Changes only when the ordered message ID set changes (not on deltas). */
  messageScopeKey?: string;
  /** Visible record revision; lets a stable array carry an O(1) delta to rows. */
  revision?: number;
  /** Invalidates the user-message lookup when an existing record's metadata changes. */
  lookupRevision?: number;
  /** Reports the virtualizer's measured viewport range without exposing its instance. */
  onVisibleRangeChange?: (range: TranscriptVisibleRange | undefined) => void;
  /** Anchor used while a history page is measured after prepending. */
  anchorRef?: { current: TranscriptScrollAnchor | undefined };
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}

const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
const MAX_EXPANDED_MESSAGE_IDS = 64;

export interface TranscriptVisibleRange {
  startIndex: number;
  endIndex: number;
}

/** Variable-height transcript window. Activities live inside stable message rows so indexes never shift mid-run. */
export const VirtualTranscript = memo(function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  sessionKey = "default",
  activity,
  activityAfterMessageId,
  activities = [],
  activeTurnStartId,
  messageScopeKey,
  revision,
  lookupRevision,
  onVisibleRangeChange,
  anchorRef,
  onCopyMessage,
  onForkMessage,
}: VirtualTranscriptProps) {
  const pendingActivities = useMemo<TranscriptActivity[]>(() => [
    ...activities,
    ...(activity ? [{ id: "turn-activity", afterMessageId: activityAfterMessageId, fallbackToTail: true, content: activity }] : []),
  ], [activities, activity, activityAfterMessageId]);
  const indexRef = useRef<{
    scopeKey?: string;
    length: number;
    firstId?: string;
    lastId?: string;
    lookupRevision?: number;
    revision?: number;
    ids: Set<string>;
    positions: Map<string, number>;
    references: Map<string, string>;
    version: number;
  } | undefined>(undefined);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  const currentIndex = indexRef.current;
  if (!currentIndex
    || currentIndex.scopeKey !== messageScopeKey
    || currentIndex.length !== messages.length
    || currentIndex.firstId !== firstId
    || currentIndex.lastId !== lastId
    || currentIndex.lookupRevision !== lookupRevision) {
    const ids = new Set<string>();
    const positions = new Map<string, number>();
    const references = new Map<string, string>();
    messages.forEach((message, index) => {
      ids.add(message.id);
      positions.set(message.id, index);
      if (message.sourceEntryId) references.set(message.sourceEntryId, message.id);
    });
    indexRef.current = {
      scopeKey: messageScopeKey,
      length: messages.length,
      firstId,
      lastId,
      lookupRevision,
      revision,
      ids,
      positions,
      references,
      version: (currentIndex?.version ?? 0) + 1,
    };
  } else if (currentIndex.revision !== revision) {
    indexRef.current = { ...currentIndex, revision };
  }
  const messageIndex = indexRef.current!;
  const normalizedActivities = useMemo(() => pendingActivities.map((entry) => ({
    ...entry,
    ...(entry.afterMessageId && messageIndex.references.has(entry.afterMessageId)
      ? { afterMessageId: messageIndex.references.get(entry.afterMessageId) }
      : {}),
  })), [pendingActivities, messageIndex.version]);
  const activitiesByMessage = useMemo(
    () => groupTranscriptActivitiesForMessageIds(messageIndex.ids, messageIndex.lastId, normalizedActivities),
    [messageIndex, normalizedActivities],
  );
  const unanchoredActivities = useMemo(
    () => unanchoredTranscriptActivitiesForMessageCount(messageIndex.length, normalizedActivities),
    [messageIndex, normalizedActivities],
  );
  const activeTurnStartIndex = useMemo(
    () => activeTurnStartId === undefined ? -1 : messageIndex.positions.get(activeTurnStartId) ?? -1,
    [activeTurnStartId, messageIndex],
  );

  const measureThrough = anchorRef?.current?.measureThrough;
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = new Set(defaultRangeExtractor(range));
    if (measureThrough !== undefined) {
      for (let index = 0; index < Math.min(measureThrough, messages.length); index += 1) indexes.add(index);
    }
    return [...indexes].sort((left, right) => left - right);
  }, [anchorRef, measureThrough, messages.length]);
  const [expandedState, setExpandedState] = useState<{ sessionKey: string; ids: ReadonlySet<string> }>(() => ({ sessionKey, ids: new Set() }));
  const expandedMessageIds = expandedState.sessionKey === sessionKey ? expandedState.ids : EMPTY_MESSAGE_IDS;
  const messageIndexes = useRef(new Map<string, number>());
  messageIndexes.current = new Map(messages.map((message, index) => [message.id, index]));
  useLayoutEffect(() => {
    if (expandedState.sessionKey === sessionKey) return;
    setExpandedState({ sessionKey, ids: new Set() });
  }, [expandedState.sessionKey, sessionKey]);

  const updateExpandedMessage = (messageId: string, expanded: boolean) => {
    setExpandedState((current) => {
      const next = new Set(current.sessionKey === sessionKey ? current.ids : EMPTY_MESSAGE_IDS);
      if (expanded) {
        // Re-inserting makes this a small LRU: frequently used expanded rows
        // stay available while abandoned IDs cannot grow without bound.
        next.delete(messageId);
        next.add(messageId);
      } else next.delete(messageId);
      while (next.size > MAX_EXPANDED_MESSAGE_IDS) next.delete(next.values().next().value!);
      return { sessionKey, ids: next };
    });
  };

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messages[index]?.id ?? index,
    initialRect: { width: 780, height: 600 },
    // Keep the initial/current-turn window small enough that long active turns
    // remain bounded without paying for a large hidden DOM on every update.
    overscan: 3,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const onMessageToggleExpanded = useTranscriptViewportAnchor({
    expandedMessageIds,
    messageIndexes,
    onExpandedChange: updateExpandedMessage,
    scrollRef,
    sessionKey,
    virtualizer,
  });

  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length > 0
    ? measuredRows
    : messages.slice(0, 12).map((message, index) => ({ index, key: message.id, start: index * 180 }));
  const visibleRange: TranscriptVisibleRange | undefined = virtualizer.range
    ? { startIndex: virtualizer.range.startIndex, endIndex: virtualizer.range.endIndex }
    : undefined;
  useLayoutEffect(() => {
    onVisibleRangeChange?.(visibleRange);
  }, [onVisibleRangeChange, visibleRange?.startIndex, visibleRange?.endIndex]);

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
          onToggleExpanded={onMessageToggleExpanded}
          expanded={expandedMessageIds.has(message.id)}
        />
        {anchoredActivities.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
      </div>;
    })}
  </div>;
});
