// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createRef, useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

const observedCounts: number[] = [];
const globalMeasure = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey(index: number): string }) => {
    observedCounts.push(count);
    const [activityHeight, setActivityHeight] = useState(0);
    const measureElement = useCallback((node: HTMLElement | null) => {
      if (!node) return;
      globalMeasure(node);
      if (node.querySelector(".inline-transcript-activity")) setActivityHeight(220);
    }, []);
    return {
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 180 + (index > 0 ? activityHeight : 0),
      })),
      getTotalSize: () => count * 180 + activityHeight,
      measurementsCache: [],
      scrollOffset: 0,
      scrollRect: null,
      measureElement,
      measure: vi.fn(),
    };
  },
}));

const messages: UiMessage[] = [
  { id: "user", role: "user", text: "Work", timestamp: 1 },
  { id: "reply", role: "assistant", text: "Working", timestamp: 2 },
];

describe("VirtualTranscript activity measurement", () => {
  beforeEach(() => {
    observedCounts.length = 0;
    globalMeasure.mockClear();
  });

  it("remeasures rows when an activity is inserted so the next message cannot overlap it", () => {
    const scrollRef = createRef<HTMLDivElement>();
    const view = render(<VirtualTranscript messages={messages} scrollRef={scrollRef} isStreaming={false} />);

    globalMeasure.mockClear();
    view.rerender(<VirtualTranscript
      messages={messages}
      scrollRef={scrollRef}
      isStreaming={false}
      activities={[{ id: "tasks-user", afterMessageId: "user", content: <div>Tasks</div> }]}
    />);

    const rows = view.container.querySelectorAll<HTMLElement>(".virtual-transcript-row");
    const nextRowTop = Number.parseFloat(rows[1]!.style.transform.match(/translateY\(([^p]+)px\)/u)?.[1] ?? "0");

    expect(observedCounts.every((count) => count === messages.length)).toBe(true);
    expect(rows).toHaveLength(messages.length);
    expect(rows[0]?.textContent).toContain("Tasks");
    expect(nextRowTop).toBeGreaterThanOrEqual(400);
    expect(globalMeasure).toHaveBeenCalledTimes(messages.length);
  });
});
