// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

const observedCounts: number[] = [];
const globalMeasure = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey(index: number): string }) => {
    observedCounts.push(count);
    return {
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 180 })),
      getTotalSize: () => count * 180,
      measureElement: vi.fn(),
      measure: globalMeasure,
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

  it("keeps virtual row indexes stable when an activity is inserted", () => {
    const scrollRef = createRef<HTMLDivElement>();
    const view = render(<VirtualTranscript messages={messages} scrollRef={scrollRef} isStreaming={false} />);

    view.rerender(<VirtualTranscript
      messages={messages}
      scrollRef={scrollRef}
      isStreaming={false}
      activities={[{ id: "tasks-user", afterMessageId: "user", content: <div>Tasks</div> }]}
    />);

    expect(observedCounts).toEqual([messages.length, messages.length]);
    expect(globalMeasure).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(messages.length);
    expect(view.container.querySelector(".virtual-transcript-row")?.textContent).toContain("Tasks");
  });
});
