import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, RefObject } from "react";
import type { UiComposerCommand, UiMessage } from "../../shared/contracts";
import { Message } from "./Message";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: Array<{ id: string; afterMessageId?: string; content: ReactNode }>;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  skillCommands?: readonly UiComposerCommand[];
}

/** Variable-height transcript window. Activities live inside stable message rows so indexes never shift mid-run. */
export function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  activity,
  activityAfterMessageId,
  activities = [],
  onCopyMessage,
  onForkMessage,
  skillCommands = [],
}: VirtualTranscriptProps) {
  const pendingActivities = [
    ...activities,
    ...(activity ? [{ id: "turn-activity", afterMessageId: activityAfterMessageId, content: activity }] : []),
  ];
  const messageIds = new Set(messages.map((message) => message.id));
  const tailMessageId = messages.at(-1)?.id;
  const activitiesByMessage = new Map<string, typeof pendingActivities>();
  for (const entry of pendingActivities) {
    const anchor = entry.afterMessageId
      ? (messageIds.has(entry.afterMessageId) ? entry.afterMessageId : entry.id === "turn-activity" ? tailMessageId : undefined)
      : tailMessageId;
    if (!anchor) continue;
    const anchored = activitiesByMessage.get(anchor) ?? [];
    anchored.push(entry);
    activitiesByMessage.set(anchor, anchored);
  }

  const unanchoredLiveActivity = messages.length === 0
    ? pendingActivities.filter((entry) => entry.id === "turn-activity")
    : [];

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messages[index]?.id ?? index,
    initialRect: { width: 780, height: 600 },
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

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
          skillCommands={skillCommands}
        />
        {anchoredActivities.map((entry) => <div className="inline-transcript-activity" key={entry.id}>{entry.content}</div>)}
      </div>;
    })}
  </div>;
}
