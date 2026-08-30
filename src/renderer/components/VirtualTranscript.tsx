import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";
import type { UiMessage } from "../../shared/contracts";
import { Message } from "./Message";

export interface VirtualTranscriptProps {
  messages: UiMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  workedMs: Record<string, number>;
  isStreaming: boolean;
}

/** Variable-height transcript window. Only visible messages and a small overscan mount. */
export function VirtualTranscript({ messages, scrollRef, workedMs, isStreaming }: VirtualTranscriptProps) {
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    getItemKey: (index) => messages[index]?.id ?? index,
    initialRect: { width: 780, height: 600 },
    overscan: 6,
  });

  const measuredRows = virtualizer.getVirtualItems();
  const rows = measuredRows.length > 0
    ? measuredRows
    : messages.slice(0, 12).map((_, index) => ({ index, key: messages[index].id, start: index * 180 }));

  return <div
    className="virtual-transcript"
    style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
  >
    {rows.map((row) => {
      const message = messages[row.index];
      return <div
        key={message.id}
        ref={virtualizer.measureElement}
        data-index={row.index}
        className="virtual-transcript-row"
        style={{ position: "absolute", width: "100%", transform: `translateY(${row.start}px)` }}
      >
        <Message
          message={message}
          workedMs={workedMs[message.id]}
          streaming={Boolean(isStreaming && row.index === messages.length - 1 && message.role === "assistant")}
        />
      </div>;
    })}
  </div>;
}
