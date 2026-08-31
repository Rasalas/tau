import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptScrollAnchor } from "../transcript-history";
import { Message } from "./Message";
import { useTranscriptViewportAnchor } from "./useTranscriptViewportAnchor";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  sessionKey?: string;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: Array<{ id: string; afterMessageId?: string; content: ReactNode }>;
  /** Anchor used while a history page is measured after prepending. */
  anchorRef?: { current: TranscriptScrollAnchor | undefined };
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
}

const EMPTY_MESSAGE_IDS: ReadonlySet<string> = new Set();
const MAX_EXPANDED_MESSAGE_IDS = 64;

interface ActivityViewportPosition {
  container: HTMLDivElement;
  scrollTop: number;
  anchor?: HTMLElement;
  anchorTop?: number;
  tracked?: HTMLElement;
  trackedHeight?: number;
  trackedTop?: number;
}

interface PendingActivityViewportRestore {
  token: number;
  position: ActivityViewportPosition;
}

function resolveMessageId(messages: readonly UiMessage[], requestedId?: string): string | undefined {
  if (!requestedId) return undefined;
  return messages.find((message) => message.id === requestedId || message.sourceEntryId === requestedId)?.id;
}

/** Variable-height transcript window. Activities live inside stable message rows so indexes never shift mid-run. */
export function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  sessionKey = "default",
  activity,
  activityAfterMessageId,
  activities = [],
  anchorRef,
  onCopyMessage,
  onForkMessage,
}: VirtualTranscriptProps) {
  const pendingActivities = [
    ...activities,
    ...(activity ? [{ id: "turn-activity", afterMessageId: activityAfterMessageId, content: activity }] : []),
  ];
  const tailMessageId = messages.at(-1)?.id;
  const activitiesByMessage = new Map<string, typeof pendingActivities>();
  for (const entry of pendingActivities) {
    const resolvedAnchor = resolveMessageId(messages, entry.afterMessageId);
    const anchor = entry.afterMessageId
      ? (resolvedAnchor ?? (entry.id === "turn-activity" ? tailMessageId : undefined))
      : tailMessageId;
    if (!anchor) continue;
    const anchored = activitiesByMessage.get(anchor) ?? [];
    anchored.push(entry);
    activitiesByMessage.set(anchor, anchored);
  }

  const unanchoredLiveActivity = messages.length === 0
    ? pendingActivities.filter((entry) => entry.id === "turn-activity")
    : [];

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
    overscan: 6,
    rangeExtractor,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const pendingActivityRestore = useRef<PendingActivityViewportRestore | undefined>(undefined);
  const activityRestoreFrames = useRef<[number, number?] | undefined>(undefined);
  const activityRestoreToken = useRef(0);
  const cancelActivityRestore = useCallback(() => {
    const [firstFrame, secondFrame] = activityRestoreFrames.current ?? [];
    if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    activityRestoreFrames.current = undefined;
    pendingActivityRestore.current = undefined;
  }, []);
  const restoreActivityViewport = useCallback((pending: PendingActivityViewportRestore) => {
    if (pendingActivityRestore.current?.token !== pending.token || activityRestoreFrames.current) return;
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        activityRestoreFrames.current = undefined;
        const current = pendingActivityRestore.current;
        if (!current || current.token !== pending.token) return;
        const { position } = current;
        if (position.anchor && position.anchorTop !== undefined && position.anchor.isConnected) {
          position.container.scrollTop = position.scrollTop + position.anchor.getBoundingClientRect().top - position.anchorTop;
        } else if (position.tracked && position.trackedTop !== undefined && position.tracked.isConnected
          && position.tracked.getBoundingClientRect().top < position.container.getBoundingClientRect().top) {
          const oldHeight = position.trackedHeight ?? 0;
          const newHeight = position.tracked.getBoundingClientRect().height;
          const maxScrollTop = Math.max(0, position.container.scrollHeight - position.container.clientHeight);
          position.container.scrollTop = Math.min(maxScrollTop, Math.max(0, position.scrollTop + newHeight - oldHeight));
        }
        pendingActivityRestore.current = undefined;
      });
      activityRestoreFrames.current = [firstFrame, secondFrame];
    });
    activityRestoreFrames.current = [firstFrame, undefined];
  }, []);
  useEffect(() => cancelActivityRestore, [cancelActivityRestore]);
  const captureActivityViewport = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!target?.closest("button")) return;
    const container = scrollRef.current;
    const row = event.currentTarget.closest<HTMLElement>(".virtual-transcript-row");
    if (!container || !row) return;
    cancelActivityRestore();
    const rows = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
    const containerTop = container.getBoundingClientRect().top;
    const rowIndex = rows.indexOf(row);
    const anchor = rows
      .slice(Math.max(0, rowIndex))
      .find((candidate) => candidate.getBoundingClientRect().top >= containerTop);
    const anchorRect = anchor?.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const pending = {
      token: ++activityRestoreToken.current,
      position: {
        container,
        scrollTop: container.scrollTop,
        ...(anchor ? { anchor } : {}),
        ...(anchorRect ? { anchorTop: anchorRect.top } : {}),
        tracked: row,
        trackedHeight: rowRect.height,
        trackedTop: rowRect.top,
      },
    } satisfies PendingActivityViewportRestore;
    pendingActivityRestore.current = pending;
    restoreActivityViewport(pending);
  }, [cancelActivityRestore, restoreActivityViewport, scrollRef]);
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

  if (messages.length === 0 && unanchoredLiveActivity.length > 0) {
    return <div className="virtual-transcript static-activity-transcript">
      {unanchoredLiveActivity.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
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
        className="virtual-transcript-row"
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
            {entry.content}
          </div>
        ))}
      </div>;
    })}
  </div>;
}
