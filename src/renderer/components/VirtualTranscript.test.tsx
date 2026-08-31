// @vitest-environment jsdom
import { useRef, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

function Fixture({ messages, activity, activityAfterMessageId, activities }: {
  messages: UiMessage[];
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: Array<{ id: string; afterMessageId?: string; content: ReactNode }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} style={{ height: 600, overflow: "auto" }}>
    <VirtualTranscript
      messages={messages}
      scrollRef={ref}
      isStreaming={false}
      activity={activity}
      activityAfterMessageId={activityAfterMessageId}
      activities={activities}
    />
  </div>;
}

class DelayedResizeObserver {
  static instances: DelayedResizeObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    DelayedResizeObserver.instances.push(this);
  }

  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  trigger(target: Element, height: number) {
    this.callback([{
      target,
      borderBoxSize: [{ blockSize: height, inlineSize: 780 }],
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function RealVirtualizerFixture({ messages }: { messages: UiMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} className="transcript virtualizer-test-container">
    <VirtualTranscript messages={messages} scrollRef={ref} isStreaming={false} />
  </div>;
}

describe("virtual transcript", () => {
  it("places aggregated tool activity between its anchor and the later reply", async () => {
    const messages: UiMessage[] = [
      { id: "user", role: "user", text: "Do the work", timestamp: 1 },
      { id: "assistant", role: "assistant", text: "Done", timestamp: 2 },
    ];
    const view = render(<Fixture
      messages={messages}
      activity={<div>3 tool steps</div>}
      activityAfterMessageId="user"
    />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(2));

    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Do the work.*3 tool steps/u),
      expect.stringContaining("Done"),
    ]);
  });

  it("keeps historical activities anchored to their own turns", async () => {
    const messages: UiMessage[] = [
      { id: "first", role: "user", text: "First", timestamp: 1 },
      { id: "first-reply", role: "assistant", text: "Finished first", timestamp: 2 },
      { id: "second", role: "user", text: "Second", timestamp: 3 },
    ];
    const view = render(<Fixture messages={messages} activities={[
      { id: "first-tasks", afterMessageId: "first", content: <div>2/2 tasks</div> },
      { id: "second-tasks", afterMessageId: "second", content: <div>0/1 tasks</div> },
    ]} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(3));
    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringMatching(/First.*2\/2 tasks/u),
      expect.stringContaining("Finished first"),
      expect.stringMatching(/Second.*0\/1 tasks/u),
    ]);
  });

  it("keeps message alignment working through the virtualization wrapper", async () => {
    const message: UiMessage = { id: "user", role: "user", text: "Right aligned", timestamp: 1 };
    const view = render(<Fixture messages={[message]} />);
    const row = await waitFor(() => view.container.querySelector<HTMLElement>(".virtual-transcript-row"));

    expect(row).not.toBeNull();
    expect(row?.style.display).toBe("flex");
    expect(row?.style.flexDirection).toBe("column");
  });

  it("keeps a thousand loaded turns out of the DOM", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const height = this.classList.contains("virtual-transcript-row") ? 180 : 600;
      return { x: 0, y: 0, top: 0, left: 0, right: 780, bottom: height, width: 780, height, toJSON: () => ({}) };
    };
    const messages: UiMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Turn ${index}`,
      timestamp: index,
    }));
    const view = render(<Fixture messages={messages} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeLessThan(40);
  });

  it("restores the visible row after delayed ResizeObserver remeasurement on expand and collapse", async () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.stubGlobal("ResizeObserver", DelayedResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafCallbacks.delete(id); });

    const previousClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const previousClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const previousOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const previousOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 780 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 780 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        const node = this as unknown as HTMLElement;
        if (!node.classList.contains("virtual-transcript-row")) return 600;
        const content = node.querySelector<HTMLElement>(".message-text-content");
        return content?.classList.contains("collapsed") ? 300 : 500;
      },
    });

    const scrollTop = 240;
    const messages: UiMessage[] = [
      { id: "long", role: "user", text: "x".repeat(601), timestamp: 1 },
      { id: "anchor", role: "assistant", text: "Current reading anchor", timestamp: 2 },
    ];
    const view = render(<RealVirtualizerFixture messages={messages} />);
    const container = view.container.querySelector<HTMLDivElement>(".virtualizer-test-container")!;
    container.scrollTop = scrollTop;

    try {
      await waitFor(() => expect(container.querySelectorAll(".virtual-transcript-row")).toHaveLength(2));
      const rows = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
      const content = rows[0].querySelector<HTMLElement>(".message-text-content")!;
      container.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });
      rows[0].getBoundingClientRect = () => ({ top: -200, bottom: content.classList.contains("collapsed") ? 100 : 300, height: content.classList.contains("collapsed") ? 300 : 500, left: 0, right: 780, width: 780, x: 0, y: -200, toJSON: () => ({}) });
      rows[1].getBoundingClientRect = () => ({ top: content.classList.contains("collapsed") ? 300 : 500, bottom: 340, height: 40, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });

      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      const observer = DelayedResizeObserver.instances.find((instance) => instance.targets.has(rows[0]));
      expect(observer).toBeTruthy();
      observer!.trigger(rows[0], 500);
      expect(container.scrollTop).toBe(scrollTop);

      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      expect(container.scrollTop).toBe(scrollTop);
      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      expect(container.scrollTop).toBe(scrollTop);
      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      expect(container.scrollTop).toBe(440);

      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      observer!.trigger(rows[0], 300);
      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      expect(container.scrollTop).toBe(scrollTop);
    } finally {
      if (previousClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", previousClientWidth);
      if (previousClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", previousClientHeight);
      if (previousOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", previousOffsetWidth);
      if (previousOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", previousOffsetHeight);
      DelayedResizeObserver.instances = [];
      vi.unstubAllGlobals();
    }
  });
});
