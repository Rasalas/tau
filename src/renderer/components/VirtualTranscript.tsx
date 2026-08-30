import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Message } from "./Message";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  activity?: ReactNode;
  activityAfterMessageId?: string;
}

/** Variable-height transcript window. Only visible messages and a small overscan mount. */
export function VirtualTranscript({
  messages,
  scrollRef,
  isStreaming,
  activity,
  activityAfterMessageId,
}: VirtualTranscriptProps) {
  const items: Array<{ type: "message"; message: UiMessage } | { type: "activity" }> = messages.map((message) => ({ type: "message", message }));
  if (activity) {
    const anchorIndex = activityAfterMessageId
      ? items.findIndex((item) => item.type === "message" && item.message.id === activityAfterMessageId)
      : -1;
    items.splice(anchorIndex >= 0 ? anchorIndex + 1 : items.length, 0, { type: "activity" });
  }
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => {
      const item = items[index];
      return item?.type === "message" ? item.message.id : "turn-activity";
    },
    initialRect: { width: 780, height: 600 },
    overscan: 6,
  });

  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length > 0
    ? measuredRows
    : items.slice(0, 12).map((item, index) => ({
      index,
      key: item.type === "message" ? item.message.id : "turn-activity",
      start: index * 180,
    }));

  return <div
    className="virtual-transcript"
    style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
  >
    {rows.map((row) => {
      const item = items[row.index];
      const key = item.type === "message" ? item.message.id : "turn-activity";
      return <div
        key={key}
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
        {item.type === "activity" ? activity : (
          <Message
            message={item.message}
            streaming={Boolean(isStreaming && item.message === messages.at(-1) && item.message.role === "assistant")}
          />
        )}
      </div>;
    })}
  </div>;
}
