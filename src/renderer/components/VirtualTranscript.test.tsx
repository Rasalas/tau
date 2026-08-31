// @vitest-environment jsdom
import { useRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

afterEach(cleanup);

function Fixture({ messages, sessionKey = "fixture", activity, activityAfterMessageId, activities }: {
  messages: UiMessage[];
  sessionKey?: string;
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
      sessionKey={sessionKey}
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

function installDelayedMeasurementHarness(options: {
  rowHeight?: (node: HTMLElement) => number;
  scrollHeight?: (node: HTMLElement) => number;
} = {}) {
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  vi.stubGlobal("ResizeObserver", DelayedResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    rafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { rafCallbacks.delete(id); });

  const properties = ["clientWidth", "clientHeight", "offsetWidth", "offsetHeight", "scrollHeight"] as const;
  const previous = new Map<typeof properties[number], PropertyDescriptor | undefined>();
  for (const property of properties) previous.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property));
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 780 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 780 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const node = this as unknown as HTMLElement;
      if (!node.classList.contains("virtual-transcript-row")) return 600;
      return options.rowHeight?.(node) ?? (node.querySelector<HTMLElement>(".message-text-content")?.classList.contains("collapsed") ? 300 : 500);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const node = this as unknown as HTMLElement;
      return options.scrollHeight?.(node) ?? 0;
    },
  });

  return {
    observerCount: () => DelayedResizeObserver.instances.length,
    observersFor: (target: Element, from = 0) => DelayedResizeObserver.instances.slice(from).filter((instance) => instance.targets.has(target)),
    trigger: (target: Element, height: number, from = 0) => {
      const observers = DelayedResizeObserver.instances.slice(from).filter((instance) => instance.targets.has(target));
      observers.forEach((observer) => observer.trigger(target, height));
      return observers;
    },
    flushFrames: async (count = 2) => {
      for (let frame = 0; frame < count; frame += 1) {
        await act(async () => { for (const callback of [...rafCallbacks.values()]) callback(0); });
      }
    },
    restore() {
      for (const property of properties) {
        const descriptor = previous.get(property);
        if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
      }
      DelayedResizeObserver.instances = [];
      vi.unstubAllGlobals();
    },
  };
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

  it("scopes expansion state to the active thread", async () => {
    const messages: UiMessage[] = [{ id: "reused", role: "user", text: "x".repeat(601), timestamp: 1 }];
    const view = render(<Fixture messages={messages} sessionKey="session-a" />);
    await waitFor(() => expect(view.container.querySelector(".virtual-transcript-row")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    view.rerender(<Fixture messages={messages} sessionKey="session-b" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy());
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
    let naturalHeightSame = false;
    const harness = installDelayedMeasurementHarness({
      rowHeight: (node) => {
        if (naturalHeightSame) return 300;
        return node.querySelector<HTMLElement>(".message-text-content")?.classList.contains("collapsed") ? 300 : 500;
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
      rows[0].getBoundingClientRect = () => {
        const height = naturalHeightSame ? 300 : content.classList.contains("collapsed") ? 300 : 500;
        return { top: -200, bottom: -200 + height, height, left: 0, right: 780, width: 780, x: 0, y: -200, toJSON: () => ({}) };
      };
      rows[1].getBoundingClientRect = () => ({ top: naturalHeightSame ? 300 : content.classList.contains("collapsed") ? 300 : 500, bottom: 340, height: 40, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });

      const observersBeforeExpand = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      const expandObservers = harness.observersFor(rows[0], observersBeforeExpand);
      expect(expandObservers).toHaveLength(1);
      harness.trigger(rows[1], 40);
      expect(container.scrollTop).toBe(scrollTop);
      harness.trigger(rows[0], 500, observersBeforeExpand);

      await harness.flushFrames(1);
      expect(container.scrollTop).toBe(scrollTop);

      await harness.flushFrames(1);
      expect(container.scrollTop).toBe(440);
      // Scroll events after the target has settled cannot affect its result.
      container.dispatchEvent(new Event("scroll"));
      expect(container.scrollTop).toBe(440);

      const observersBeforeCollapse = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      const collapseObservers = harness.observersFor(rows[0], observersBeforeCollapse);
      expect(collapseObservers).toHaveLength(1);
      fireEvent.wheel(container);
      harness.trigger(rows[0], 300, observersBeforeCollapse);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(440);

      // A rapid reversal must cancel the first toggle's pending restore.
      const observersBeforeRapidExpand = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      const rapidExpandObservers = harness.observersFor(rows[0], observersBeforeRapidExpand);
      expect(rapidExpandObservers).toHaveLength(1);
      harness.trigger(rows[0], 500, observersBeforeRapidExpand);
      const observersBeforeRapidCollapse = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      const rapidCollapseObservers = harness.observersFor(rows[0], observersBeforeRapidCollapse);
      expect(rapidCollapseObservers).toHaveLength(1);
      harness.trigger(rows[0], 300, observersBeforeRapidCollapse);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(440);

      // ResizeObserver also delivers an initial observation when the natural
      // row size is unchanged. It must settle the target without a stale jump.
      naturalHeightSame = true;
      const observersBeforeUnchanged = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      const unchangedObservers = harness.observersFor(rows[0], observersBeforeUnchanged);
      expect(unchangedObservers).toHaveLength(1);
      harness.trigger(rows[0], 300, observersBeforeUnchanged);
      await harness.flushFrames();
      container.dispatchEvent(new Event("scroll"));
      expect(container.scrollTop).toBe(440);

      // A scroll-only user signal cancels a pending restore even without a
      // wheel, pointer, touch, or keyboard precursor.
      const beforeScrollCancel = harness.observerCount();
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      const scrollCancelObservers = harness.observersFor(rows[0], beforeScrollCancel);
      expect(scrollCancelObservers).toHaveLength(1);
      container.dispatchEvent(new Event("scroll"));
      harness.trigger(rows[0], 500, beforeScrollCancel);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(440);
    } finally {
      harness.restore();
    }
  });

  it("uses an absolute clamped target when a tail row changes near the bottom", async () => {
    const harness = installDelayedMeasurementHarness({
      scrollHeight: (node) => node.classList.contains("virtualizer-test-container")
        ? (node.querySelector<HTMLElement>(".message-text-content")?.classList.contains("collapsed") ? 700 : 900)
        : 0,
    });
    const view = render(<RealVirtualizerFixture messages={[{ id: "tail", role: "user", text: "x".repeat(601), timestamp: 1 }]} />);
    const container = view.container.querySelector<HTMLDivElement>(".virtualizer-test-container")!;
    try {
      await waitFor(() => expect(container.querySelectorAll(".virtual-transcript-row")).toHaveLength(1));
      const row = container.querySelector<HTMLElement>(".virtual-transcript-row")!;
      const content = row.querySelector<HTMLElement>(".message-text-content")!;
      container.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 780, width: 780, x: 0, y: 0, toJSON: () => ({}) });
      row.getBoundingClientRect = () => {
        const height = content.classList.contains("collapsed") ? 300 : 500;
        return { top: -200, bottom: -200 + height, height, left: 0, right: 780, width: 780, x: 0, y: -200, toJSON: () => ({}) };
      };

      container.scrollTop = 100;
      const beforeExpand = harness.observerCount();
      fireEvent.click(row.querySelector<HTMLButtonElement>("button.message-expand")!);
      const expandObservers = harness.observersFor(row, beforeExpand);
      expect(expandObservers).toHaveLength(1);
      harness.trigger(row, 500, beforeExpand);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(300);

      const beforeCollapse = harness.observerCount();
      fireEvent.click(row.querySelector<HTMLButtonElement>("button.message-expand")!);
      const collapseObservers = harness.observersFor(row, beforeCollapse);
      expect(collapseObservers).toHaveLength(1);
      // A scroll-only signal that is not the browser's exact natural clamp is
      // user intent and must cancel the delayed restore.
      container.scrollTop = 50;
      container.dispatchEvent(new Event("scroll"));
      harness.trigger(row, 300, beforeCollapse);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(50);

      // Re-expand so the following collapse exercises the browser clamp path.
      const beforeReexpand = harness.observerCount();
      fireEvent.click(row.querySelector<HTMLButtonElement>("button.message-expand")!);
      const reexpandObservers = harness.observersFor(row, beforeReexpand);
      expect(reexpandObservers).toHaveLength(1);
      harness.trigger(row, 500, beforeReexpand);
      await harness.flushFrames();

      // Model the browser's pre-delivery clamp to the new max scrollTop.
      const beforeClampedCollapse = harness.observerCount();
      fireEvent.click(row.querySelector<HTMLButtonElement>("button.message-expand")!);
      const clampedCollapseObservers = harness.observersFor(row, beforeClampedCollapse);
      expect(clampedCollapseObservers).toHaveLength(1);
      container.scrollTop = 100;
      container.dispatchEvent(new Event("scroll"));
      harness.trigger(row, 300, beforeClampedCollapse);
      await harness.flushFrames();
      // The target is based on the pre-toggle offset (250 - 200), then
      // clamped once against the new max. It must not subtract the shrink
      // from the browser-clamped 100 a second time.
      expect(container.scrollTop).toBe(50);
    } finally {
      harness.restore();
    }
  });
});
