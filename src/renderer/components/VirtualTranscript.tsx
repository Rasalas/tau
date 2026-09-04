import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptScrollAnchor } from "../transcript-history";
import { Message } from "./Message";
import {
  groupTranscriptActivitiesForMessageIds,
  unanchoredTranscriptActivitiesForMessageCount,
  type TranscriptActivity,
} from "./transcript-activity";
import { RowViewportKeeper } from "./transcript-scroll-controller";
import { useTranscriptViewportAnchor } from "./useTranscriptViewportAnchor";
import { LazyFeatureBoundary } from "./LazyFeature";

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
  /** Visible record revision; only invalidates this memoized component. */
  revision?: number;
  /** Invalidates the user-message lookup when an existing record's metadata changes. */
  lookupRevision?: number;
  /** Anchor used while a history page is measured after prepending. */
  anchorRef?: { current: TranscriptScrollAnchor | undefined };
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}

const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
const MAX_EXPANDED_MESSAGE_IDS = 64;

interface ActivityLayoutSnapshot {
  activities: readonly TranscriptActivity[];
  messageIds: ReadonlySet<string>;
  tailMessageId?: string;
}

function activityAnchor(activity: TranscriptActivity, messageIds: ReadonlySet<string>, tailMessageId?: string): string | undefined {
  if (!activity.afterMessageId) return tailMessageId;
  if (messageIds.has(activity.afterMessageId)) return activity.afterMessageId;
  return activity.fallbackToTail ? tailMessageId : undefined;
}

function sameActivityLayout(previous: ActivityLayoutSnapshot, activities: readonly TranscriptActivity[], messageIds: ReadonlySet<string>, tailMessageId?: string): boolean {
  if (previous.activities.length !== activities.length) return false;
  return activities.every((activity, index) => {
    const old = previous.activities[index];
    return old?.id === activity.id
      && activityAnchor(old, previous.messageIds, previous.tailMessageId) === activityAnchor(activity, messageIds, tailMessageId);
  });
}

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
  lookupRevision,
  anchorRef,
  onCopyMessage,
  onForkMessage,
}: VirtualTranscriptProps) {
  const pendingActivities = useMemo<TranscriptActivity[]>(() => [
    ...activities,
    ...(activity ? [{ id: "turn-activity", afterMessageId: activityAfterMessageId, fallbackToTail: true, content: activity }] : []),
  ], [activities, activity, activityAfterMessageId]);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  // Rebuilt only when the ordered ID set changes, never for streaming deltas.
  const messageIndex = useMemo(() => {
    const ids = new Set<string>();
    const positions = new Map<string, number>();
    const references = new Map<string, string>();
    messages.forEach((message, index) => {
      ids.add(message.id);
      positions.set(message.id, index);
      if (message.sourceEntryId) references.set(message.sourceEntryId, message.id);
    });
    return { length: messages.length, lastId, ids, positions, references };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageScopeKey, messages.length, firstId, lastId, lookupRevision]);
  const normalizedActivities = useMemo(() => pendingActivities.map((entry) => ({
    ...entry,
    ...(entry.afterMessageId && messageIndex.references.has(entry.afterMessageId)
      ? { afterMessageId: messageIndex.references.get(entry.afterMessageId) }
      : {}),
  })), [pendingActivities, messageIndex]);
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
  // The transcript index already owns this mapping. Reusing it avoids a second
  // full message scan and map allocation on every render of a long transcript.
  const messageIndexes = useRef<Map<string, number>>(messageIndex.positions);
  useLayoutEffect(() => { messageIndexes.current = messageIndex.positions; }, [messageIndex]);
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
    // The first pass only needs a small window. The real scroll element is
    // measured immediately after mount and expands the range on the next
    // frame, while this keeps the mount-critical work bounded for long logs.
    initialRect: { width: 780, height: messages.length >= 200 ? 360 : 600 },
    // Keep the initial/current-turn window small enough that long active turns
    // remain bounded without paying for a large hidden DOM on every update.
    overscan: messages.length >= 200 ? 0 : 3,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
  });
  // Not a `useVirtualizer` option in virtual-core 3.x. The controller owns
  // every scroll write, so the virtualizer never compensates on its own.
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  }, [virtualizer]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const activityLayout = useRef<ActivityLayoutSnapshot>({
    activities: normalizedActivities,
    messageIds: messageIndex.ids,
    tailMessageId: messageIndex.lastId,
  });
  useLayoutEffect(() => {
    const previous = activityLayout.current;
    activityLayout.current = { activities: normalizedActivities, messageIds: messageIndex.ids, tailMessageId: messageIndex.lastId };
    if (sameActivityLayout(previous, normalizedActivities, messageIndex.ids, messageIndex.lastId)) return;
    transcriptRef.current?.querySelectorAll<HTMLElement>(".virtual-transcript-row")
      .forEach((row) => virtualizer.measureElement(row));
  }, [messageIndex.lastId, normalizedActivities, virtualizer]);

  const [activityKeeper] = useState(() => new RowViewportKeeper());
  useEffect(() => () => activityKeeper.cancel(), [activityKeeper]);
  const captureActivityViewport = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!target?.closest("button")) return;
    const container = scrollRef.current;
    const row = event.currentTarget.closest<HTMLElement>(".virtual-transcript-row");
    if (!container || !row) return;
    activityKeeper.queueRestore(activityKeeper.capture(container, row));
  }, [activityKeeper, scrollRef]);

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
  const visibleRangeStart = virtualizer.range?.startIndex;
  const visibleRangeEnd = virtualizer.range?.endIndex;

  if (messages.length === 0 && unanchoredActivities.length > 0) {
    return <div ref={transcriptRef} className="virtual-transcript static-activity-transcript">
      {unanchoredActivities.map((entry) => (
        <div className="inline-transcript-activity" key={entry.id}>
          <LazyFeatureBoundary label={entry.id}>
            {entry.content}
          </LazyFeatureBoundary>
        </div>
      ))}
    </div>;
  }

  return <div
    ref={transcriptRef}
    className="virtual-transcript"
    style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
    data-visible-start-index={visibleRangeStart}
    data-visible-end-index={visibleRangeEnd}
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
        {anchoredActivities.map((entry) => (
          <div
            className="inline-transcript-activity"
            key={entry.id}
            onClickCapture={captureActivityViewport}
          >
            <LazyFeatureBoundary label={entry.id}>
              {entry.content}
            </LazyFeatureBoundary>
          </div>
        ))}
      </div>;
    })}
  </div>;
});
