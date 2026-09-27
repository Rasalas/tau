// @vitest-environment jsdom
import { createRef, useRef, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { afterEach, vi } from "vitest";
import { testDomRect } from "./test-dom-geometry";
import { TranscriptViewport } from "./TranscriptViewport";
import { VirtualTranscript } from "./VirtualTranscript";
import type { TranscriptActivity } from "./transcript-activity";
import type { TranscriptDetail } from "../../workbench/transcript-folding";

afterEach(async () => {
  cleanup();
  // The virtualizer remeasures rows inside a requestAnimationFrame it never
  // cancels. Drain those callbacks while the jsdom window still exists.
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
});

function Fixture({ messages, sessionKey = "fixture", activity, activityAfterMessageId, activities, detail, onCopyMessage, onForkMessage, onFocusComposer }: {
  messages: UiMessage[];
  sessionKey?: string;
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: TranscriptActivity[];
  detail?: TranscriptDetail;
  onCopyMessage?: (message: UiMessage) => void;
  onForkMessage?: (message: UiMessage) => void;
  onFocusComposer?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const allActivities: TranscriptActivity[] = [
    ...(activities ?? []),
    ...(activity ? [{
      id: "turn-activity",
      afterMessageId: activityAfterMessageId,
      fallbackToTail: true,
      content: activity,
    }] : []),
  ];
  return <div ref={ref} style={{ height: 600, overflow: "auto" }}>
    <VirtualTranscript
      messages={messages}
      scrollRef={ref}
      isStreaming={false}
      sessionKey={sessionKey}
      activities={allActivities}
      detail={detail}
      onCopyMessage={onCopyMessage}
      onForkMessage={onForkMessage}
      onFocusComposer={onFocusComposer}
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
  getBoundingClientRect?: (node: HTMLElement) => DOMRect;
} = {}) {
  const pendingFrameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  vi.stubGlobal("ResizeObserver", DelayedResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    pendingFrameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { pendingFrameCallbacks.delete(id); });

  const properties = ["clientWidth", "clientHeight", "offsetWidth", "offsetHeight", "scrollHeight", "getBoundingClientRect"] as const;
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
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (options.getBoundingClientRect) return options.getBoundingClientRect(this);
      const original = previous.get("getBoundingClientRect")?.value;
      return typeof original === "function"
        ? original.call(this)
        : testDomRect();
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
        await act(async () => {
          const due = [...pendingFrameCallbacks.entries()];
          for (const [id] of due) pendingFrameCallbacks.delete(id);
          for (const [, callback] of due) callback(0);
        });
      }
    },
    restore() {
      pendingFrameCallbacks.clear();
      for (const property of properties) {
        const descriptor = previous.get(property);
        if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
      }
      DelayedResizeObserver.instances = [];
      vi.unstubAllGlobals();
      vi.clearAllTimers();
    },
  };
}

function RealVirtualizerFixture({ messages }: { messages: UiMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} className="transcript virtualizer-test-container">
    <VirtualTranscript messages={messages} scrollRef={ref} isStreaming={false} />
  </div>;
}

function ToggleActivity() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen((value) => !value)}>{open ? "Close activity" : "Open activity"}</button>
    {open ? <div className="activity-expanded">Expanded activity details</div> : null}
  </>;
}

function ActivityViewportFixture() {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} className="activity-viewport-test" style={{ height: 600, overflow: "auto" }}>
    <VirtualTranscript
      messages={[
        { id: "activity-owner", role: "user", text: "Request", timestamp: 1 },
        { id: "reading-anchor", role: "assistant", text: "Current reading position", timestamp: 2 },
      ]}
      scrollRef={ref}
      isStreaming={false}
      activity={<ToggleActivity />}
      activityAfterMessageId="activity-owner"
    />
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

  it("keeps the reading anchor stable when an activity row opens", async () => {
    const harness = installDelayedMeasurementHarness({
      rowHeight: (node) => node.querySelector(".activity-expanded") ? 500 : 300,
      scrollHeight: (node) => node.classList.contains("activity-viewport-test") ? 1_200 : 0,
      getBoundingClientRect: (node) => {
        if (!node.classList.contains("virtual-transcript-row")) return testDomRect({ top: 0, bottom: 600, height: 600 });
        const rows = [...node.parentElement!.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
        const index = rows.indexOf(node);
        const scrollTop = node.parentElement?.parentElement?.scrollTop ?? 0;
        const top = rows.slice(0, index).reduce((total, previous) => total + (previous.querySelector(".activity-expanded") ? 500 : 300), 0) - scrollTop;
        const height = node.querySelector(".activity-expanded") ? 500 : 300;
        return testDomRect({ top, bottom: top + height, height, y: top });
      },
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<ActivityViewportFixture />);
      const container = view.container.querySelector<HTMLDivElement>(".activity-viewport-test")!;
      container.scrollTop = 100;
      await waitFor(() => expect(screen.getByRole("button", { name: "Open activity" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Open activity" }));
      const activityRow = container.querySelector<HTMLElement>(".virtual-transcript-row")!;
      harness.trigger(activityRow, 500);
      await harness.flushFrames();
      expect(container.scrollTop).toBe(300);
      expect(container.querySelector(".virtual-transcript-row:last-child")?.getBoundingClientRect().top).toBe(200);
    } finally {
      view?.unmount();
      harness.restore();
    }
  });

  it("follows an activity's height after the turn's rows remount under persisted ids", async () => {
    const harness = installDelayedMeasurementHarness({ rowHeight: (node) => node.querySelector(".activity-expanded") ? 500 : 300 });
    const live: UiMessage[] = [
      { id: "user-live", role: "user", text: "Request", timestamp: 1 },
      { id: "answer-live", role: "assistant", text: "Answer", timestamp: 2 },
    ];
    const persisted: UiMessage[] = [
      { id: "user-entry", sourceEntryId: "user-entry", role: "user", text: "Request", timestamp: 1 },
      { id: "answer-entry", sourceEntryId: "answer-entry", role: "assistant", text: "Answer", timestamp: 2 },
    ];
    const answerTop = (container: HTMLElement) => {
      const row = container.querySelector<HTMLElement>('.virtual-transcript-row[data-index="1"]')!;
      return Number.parseFloat(row.style.transform.match(/translateY\(([^p]+)px\)/u)?.[1] ?? "NaN");
    };
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<Fixture messages={live} activity={<ToggleActivity />} activityAfterMessageId="user-live" />);
      await harness.flushFrames();
      // A resize of the live rows is waiting for its frame when the settle
      // replaces them with rows under the persisted ids.
      for (const row of view.container.querySelectorAll<HTMLElement>(".virtual-transcript-row")) harness.trigger(row, 300);
      view.rerender(<Fixture messages={persisted} activity={<ToggleActivity />} activityAfterMessageId="user-entry" />);
      await harness.flushFrames();
      expect(answerTop(view.container)).toBe(300);

      fireEvent.click(screen.getByRole("button", { name: "Open activity" }));
      const owner = view.container.querySelector<HTMLElement>('.virtual-transcript-row[data-index="0"]')!;
      harness.trigger(owner, 500);
      await harness.flushFrames();
      expect(answerTop(view.container)).toBe(500);

      fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
      harness.trigger(owner, 300);
      await harness.flushFrames();
      expect(answerTop(view.container)).toBe(300);
    } finally {
      view?.unmount();
      harness.restore();
    }
  });

  it("resolves persisted entry anchors after message ids are remapped", async () => {
    const messages: UiMessage[] = [
      { id: "rendered-user", sourceEntryId: "persisted-user", role: "user", text: "Persisted request", timestamp: 1 },
      { id: "rendered-answer", sourceEntryId: "persisted-answer", role: "assistant", text: "Persisted answer", timestamp: 2 },
      { id: "later", role: "user", text: "Later request", timestamp: 3 },
    ];
    const view = render(<Fixture messages={messages} activities={[
      { id: "checkpoint", afterMessageId: "persisted-answer", content: <div>turn changes</div> },
    ]} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(3));
    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Persisted request"),
      expect.stringMatching(/Persisted answer.*turn changes/u),
      expect.stringContaining("Later request"),
    ]);
  });

  it("does not move an unresolved historical activity to the tail", async () => {
    const messages: UiMessage[] = [
      { id: "first", role: "user", text: "First", timestamp: 1 },
      { id: "latest", role: "assistant", text: "Latest", timestamp: 2 },
    ];
    const view = render(<Fixture messages={messages} activities={[
      { id: "old-checkpoint", afterMessageId: "paged-out-answer", content: <div>old changes</div> },
    ]} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(2));
    expect(view.container.textContent).not.toContain("old changes");
    expect(view.container.querySelector(".virtual-transcript-row:last-child")?.textContent).toContain("Latest");
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
    const harness = installDelayedMeasurementHarness({
      getBoundingClientRect: (node) => {
        const height = node.classList.contains("virtual-transcript-row") ? 180 : 600;
        return testDomRect({ bottom: height, height });
      },
    });
    const messages: UiMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Turn ${index}`,
      timestamp: index,
    }));
    const view = render(<Fixture messages={messages} />);
    try {
      await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeGreaterThan(0));
      expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeLessThan(40);
    } finally {
      view.unmount();
      harness.restore();
    }
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
    let view: ReturnType<typeof render> | undefined;

    try {
      view = render(<RealVirtualizerFixture messages={messages} />);
      const container = view.container.querySelector<HTMLDivElement>(".virtualizer-test-container")!;
      container.scrollTop = scrollTop;
      await waitFor(() => expect(container.querySelectorAll(".virtual-transcript-row")).toHaveLength(2));
      const rows = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")];
      const content = rows[0].querySelector<HTMLElement>(".message-text-content")!;
      container.getBoundingClientRect = () => testDomRect({ bottom: 600, height: 600 });
      rows[0].getBoundingClientRect = () => {
        const height = naturalHeightSame ? 300 : content.classList.contains("collapsed") ? 300 : 500;
        return testDomRect({ top: -200, bottom: -200 + height, height, y: -200 });
      };
      rows[1].getBoundingClientRect = () => testDomRect({ top: naturalHeightSame ? 300 : content.classList.contains("collapsed") ? 300 : 500, bottom: 340, height: 40 });

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
      view?.unmount();
      harness.restore();
    }
  });

  it("uses an absolute clamped target when a tail row changes near the bottom", async () => {
    const harness = installDelayedMeasurementHarness({
      scrollHeight: (node) => node.classList.contains("virtualizer-test-container")
        ? (node.querySelector<HTMLElement>(".message-text-content")?.classList.contains("collapsed") ? 700 : 900)
        : 0,
    });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<RealVirtualizerFixture messages={[{ id: "tail", role: "user", text: "x".repeat(601), timestamp: 1 }]} />);
      const container = view.container.querySelector<HTMLDivElement>(".virtualizer-test-container")!;
      await waitFor(() => expect(container.querySelectorAll(".virtual-transcript-row")).toHaveLength(1));
      const row = container.querySelector<HTMLElement>(".virtual-transcript-row")!;
      const content = row.querySelector<HTMLElement>(".message-text-content")!;
      container.getBoundingClientRect = () => testDomRect({ bottom: 600, height: 600 });
      row.getBoundingClientRect = () => {
        const height = content.classList.contains("collapsed") ? 300 : 500;
        return testDomRect({ top: -200, bottom: -200 + height, height, y: -200 });
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
      view?.unmount();
      harness.restore();
    }
  });

  it("keeps the anchored current turn bounded with thousands of records and activities", async () => {
    const messages: UiMessage[] = Array.from({ length: 3_000 }, (_, index) => ({
      id: `current-${index}`,
      role: index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "notice",
      text: `Current turn record ${index}`,
      timestamp: index,
    }));
    const activities = messages.map((message, index) => ({
      id: `activity-${index}`,
      afterMessageId: message.id,
      content: <span>Activity {index}</span>,
    }));
    const scrollRef = createRef<HTMLDivElement>();
    const view = render(<TranscriptViewport
      messages={messages}
      scrollRef={scrollRef}
      sessionId="long-turn"
      turnStart={{
        turnId: "long-turn-start",
        sessionId: "long-turn",
        messageId: messages[0].id,
        text: messages[0].text,
        timestamp: messages[0].timestamp,
      }}
      isStreaming
      activities={activities}
      liveStatus={<span>Live</span>}
    />);

    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeLessThan(40);
    expect(view.container.querySelectorAll(".inline-transcript-activity").length).toBeLessThan(40);
    view.unmount();
  });

  it("keeps the leading row in place when unmeasured older rows are prepended", async () => {
    // Older rows are 250 px once measured; the virtualizer first places them at the 100 px it learned from the newer rows.
    const heights = new Map<string, number>();
    const harness = installDelayedMeasurementHarness({
      rowHeight: (node) => heights.get(node.dataset.messageId ?? "") ?? 100,
    });
    const page = (from: number, to: number): UiMessage[] => Array.from({ length: to - from }, (_, offset) => ({
      id: `m${from + offset}`,
      role: (from + offset) % 2 ? "assistant" : "user",
      text: `Turn ${from + offset}`,
      timestamp: from + offset,
    }));
    const newer = page(100, 200);
    const older = page(50, 100);
    older.forEach((message) => heights.set(message.id, 250));
    const rowTop = (container: HTMLElement, id: string) => {
      const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      return row ? Number(row.style.transform.match(/translateY\((-?[\d.]+)px\)/u)?.[1]) - container.scrollTop : undefined;
    };
    const view = render(<Fixture messages={newer} />);
    try {
      const container = view.container.firstElementChild as HTMLDivElement;
      container.scrollTop = 1_030;
      await act(async () => { container.dispatchEvent(new Event("scroll")); });
      await waitFor(() => expect(rowTop(container, "m110")).toBe(-30));

      view.rerender(<Fixture messages={[...older, ...newer]} />);
      // Same commit: the leading row is mounted and still 30 px above the viewport top.
      expect(rowTop(container, "m110")).toBe(-30);
      expect(container.scrollTop).toBeGreaterThan(50 * 100);

      // The virtualizer catches up with the new offset; a row above the leading one is measured late.
      await act(async () => { container.dispatchEvent(new Event("scroll")); });
      expect(rowTop(container, "m110")).toBe(-30);
      heights.set("m109", 400);
      const lateRow = container.querySelector<HTMLElement>('[data-message-id="m109"]')!;
      harness.trigger(lateRow, 400);
      await harness.flushFrames();
      expect(rowTop(container, "m110")).toBe(-30);

      // After the reader scrolls, the row they are on keeps its place when it grows at its bottom.
      container.scrollTop -= 500;
      await act(async () => { container.dispatchEvent(new Event("scroll")); });
      const readerTop = rowTop(container, "m108");
      expect(readerTop).toBeLessThanOrEqual(0);
      heights.set("m108", 600);
      const readerRow = container.querySelector<HTMLElement>('[data-message-id="m108"]')!;
      harness.trigger(readerRow, 600);
      await harness.flushFrames();
      expect(rowTop(container, "m108")).toBe(readerTop);
    } finally {
      view.unmount();
      harness.restore();
    }
  });

  it("moves the rows the reader sees by exactly the scroll while rows above them get measured", async () => {
    // Heights differ within a kind, so every estimate is off.
    const height = (index: number) => 60 + (index % 7) * 45;
    const harness = installDelayedMeasurementHarness({
      rowHeight: (node) => height(Number(node.dataset.index)),
    });
    const messages: UiMessage[] = Array.from({ length: 300 }, (_, index) => ({
      id: `r${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Row ${index}`,
      timestamp: index,
    }));
    const rowTop = (container: HTMLElement, id: string) => {
      const row = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      return row ? Number(row.style.transform.match(/translateY\((-?[\d.]+)px\)/u)?.[1]) - container.scrollTop : undefined;
    };
    const view = render(<Fixture messages={messages} />);
    try {
      const container = view.container.firstElementChild as HTMLDivElement;
      container.scrollTop = 40_000;
      await act(async () => { container.dispatchEvent(new Event("scroll")); });
      await harness.flushFrames();
      for (let step = 0; step < 40; step += 1) {
        const visible = [...container.querySelectorAll<HTMLElement>(".virtual-transcript-row")]
          .map((row) => ({ id: row.dataset.messageId!, top: rowTop(container, row.dataset.messageId!)! }))
          .filter((row) => row.top >= 0 && row.top + 240 < 600)
          .sort((left, right) => left.top - right.top);
        expect(visible.length).toBeGreaterThan(0);
        container.scrollTop -= 240;
        await act(async () => { container.dispatchEvent(new Event("scroll")); });
        await harness.flushFrames();
        // Now and then the scroll settles too: virtual-core reports that 150 ms after the last event.
        if (step % 8 === 0) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        for (const row of visible) expect(rowTop(container, row.id)).toBe(row.top + 240);
      }
    } finally {
      view.unmount();
      harness.restore();
    }
  });

  it("learns a row size per kind for rows it has not measured", async () => {
    const harness = installDelayedMeasurementHarness({
      rowHeight: (node) => node.dataset.rowKind === "user" ? 50 : 150,
    });
    const messages: UiMessage[] = Array.from({ length: 400 }, (_, index) => ({
      id: `k${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Row ${index}`,
      timestamp: index,
    }));
    const view = render(<Fixture messages={messages} />);
    try {
      await harness.flushFrames();
      const content = view.container.querySelector<HTMLElement>(".virtual-transcript")!;
      expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeLessThan(40);
      // 200 prompts at 50 px and 200 answers at 150 px, most of them never mounted.
      expect(content.style.height).toBe("40000px");
    } finally {
      view.unmount();
      harness.restore();
    }
  });

  describe("keyboard navigation", () => {
    it("navigates rows with j/k and ArrowDown/ArrowUp", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "user", text: "First message", timestamp: 1 },
        { id: "msg-1", role: "assistant", text: "Second message", timestamp: 2 },
        { id: "msg-2", role: "user", text: "Third message", timestamp: 3 },
      ];
      const view = render(<Fixture messages={messages} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;
      expect(transcript).not.toBeNull();
      expect(transcript.tabIndex).toBe(0);

      // Press 'j' -> moves focus to index 0
      fireEvent.keyDown(transcript, { key: "j" });
      expect(transcript.dataset.focusedIndex).toBe("0");
      const rows = view.container.querySelectorAll(".virtual-transcript-row");
      expect(rows[0].classList.contains("focused")).toBe(true);

      // Press ArrowDown -> moves to index 1
      fireEvent.keyDown(transcript, { key: "ArrowDown" });
      expect(transcript.dataset.focusedIndex).toBe("1");
      expect(rows[1].classList.contains("focused")).toBe(true);

      // Press 'k' -> moves back to index 0
      fireEvent.keyDown(transcript, { key: "k" });
      expect(transcript.dataset.focusedIndex).toBe("0");

      // Press ArrowUp at 0 -> stays at index 0
      fireEvent.keyDown(transcript, { key: "ArrowUp" });
      expect(transcript.dataset.focusedIndex).toBe("0");
      view.unmount();
    });

    it("toggles folds and thinking blocks with Space and Enter", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "assistant", text: "Here is answer", thinking: "Deep thought", timestamp: 1 },
      ];
      const view = render(<Fixture messages={messages} detail="detailed" />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      fireEvent.keyDown(transcript, { key: "j" });
      expect(transcript.dataset.focusedIndex).toBe("0");

      const thinking = view.container.querySelector("details.message-thinking") as HTMLDetailsElement;
      expect(thinking).not.toBeNull();
      const initialOpen = thinking.open;

      fireEvent.keyDown(transcript, { key: " " });
      expect(thinking.open).toBe(!initialOpen);
      view.unmount();
    });

    it("copies focused row text or code with y", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "assistant", text: "Some code answer\n```js\nconsole.log(123);\n```", timestamp: 1 },
      ];
      const onCopyMessage = vi.fn();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const view = render(<Fixture messages={messages} onCopyMessage={onCopyMessage} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      fireEvent.keyDown(transcript, { key: "j" });
      fireEvent.keyDown(transcript, { key: "y" });

      expect(onCopyMessage).toHaveBeenCalledWith(messages[0]);
      expect(writeText).toHaveBeenCalled();
      view.unmount();
    });

    it("returns focus to composer on Escape or i", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "user", text: "Hello", timestamp: 1 },
      ];
      const onFocusComposer = vi.fn();
      const view = render(<Fixture messages={messages} onFocusComposer={onFocusComposer} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      fireEvent.keyDown(transcript, { key: "j" });
      fireEvent.keyDown(transcript, { key: "Escape" });
      expect(onFocusComposer).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(transcript, { key: "i" });
      expect(onFocusComposer).toHaveBeenCalledTimes(2);
      view.unmount();
    });

    it("walks from a message into its actions and back: → in, ←/→ along, ← or Escape out, ↑/↓ to the next message", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "user", text: "First prompt", timestamp: 1, sourceEntryId: "e0" },
        { id: "msg-1", role: "assistant", text: "An answer", timestamp: 2, sourceEntryId: "e1" },
      ];
      const onFocusComposer = vi.fn();
      const onForkMessage = vi.fn();
      const view = render(<Fixture messages={messages} onCopyMessage={vi.fn()} onForkMessage={onForkMessage} onFocusComposer={onFocusComposer} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;
      const rows = view.container.querySelectorAll<HTMLElement>(".virtual-transcript-row");
      const actionsOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>(".message-actions button")];
      // The transcript is the one tab stop; the actions are reached through their message.
      expect(actionsOf(rows[0]!).map((button) => button.tabIndex)).toEqual([-1, -1]);

      // Focus puts the cursor on the first message in view.
      act(() => transcript.focus());
      expect(transcript.dataset.focusedIndex).toBe("0");
      fireEvent.keyDown(transcript, { key: "ArrowRight" });
      expect(document.activeElement).toBe(actionsOf(rows[0]!)[0]);
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      expect(document.activeElement?.textContent).toBe("Fork");
      fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
      expect(document.activeElement?.textContent).toBe("Fork");
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(document.activeElement?.textContent).toBe("Copy");
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(transcript);

      fireEvent.keyDown(transcript, { key: "ArrowRight" });
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      // Enter is the button's own: it forks, and the transcript does not take the key.
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      fireEvent.click(document.activeElement!);
      expect(onForkMessage).toHaveBeenCalledWith(messages[0]);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(document.activeElement).toBe(transcript);
      expect(onFocusComposer).not.toHaveBeenCalled();
      expect(transcript.dataset.focusedIndex).toBe("0");

      fireEvent.keyDown(transcript, { key: "ArrowRight" });
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(transcript);
      expect(transcript.dataset.focusedIndex).toBe("1");
      view.unmount();
    });

    it("keeps an action's Escape in the transcript, not the composer, inside the scrolling viewport", async () => {
      const messages: UiMessage[] = [{ id: "msg-0", role: "user", text: "A prompt", timestamp: 1 }];
      const onFocusComposer = vi.fn();
      const scrollRef = createRef<HTMLDivElement>();
      const view = render(<TranscriptViewport messages={messages} scrollRef={scrollRef} sessionId="s" isStreaming onCopyMessage={vi.fn()} onFocusComposer={onFocusComposer} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;
      act(() => transcript.focus());
      fireEvent.keyDown(transcript, { key: "ArrowRight" });
      expect(document.activeElement?.textContent).toBe("Copy");
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(document.activeElement).toBe(transcript);
      expect(onFocusComposer).not.toHaveBeenCalled();
      fireEvent.keyDown(transcript, { key: "Escape" });
      expect(onFocusComposer).toHaveBeenCalledOnce();
      view.unmount();
    });

    it("moves the cursor to a clicked message", async () => {
      const messages: UiMessage[] = [
        { id: "msg-0", role: "user", text: "First message", timestamp: 1 },
        { id: "msg-1", role: "assistant", text: "Second message", timestamp: 2 },
      ];
      const view = render(<Fixture messages={messages} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;
      const rows = view.container.querySelectorAll(".virtual-transcript-row");

      // Selecting text in a message ends in a click on its row: the cursor goes
      // there so `y` copies that message, and the keyboard picks it up from
      // there. Whether the ring is drawn is the stylesheet's `:focus-visible`
      // rule, not this component's.
      fireEvent.click(rows[1]);
      expect(transcript.dataset.focusedIndex).toBe("1");

      fireEvent.keyDown(transcript, { key: "j" });
      expect(transcript.dataset.focusedIndex).toBe("1");
      expect(rows[1].classList.contains("focused")).toBe(true);
      view.unmount();
    });

    it("jumps between user turns with n and p", async () => {
      const messages: UiMessage[] = [
        { id: "u1", role: "user", text: "Turn 1", timestamp: 1 },
        { id: "a1", role: "assistant", text: "Answer 1", timestamp: 2 },
        { id: "u2", role: "user", text: "Turn 2", timestamp: 3 },
        { id: "a2", role: "assistant", text: "Answer 2", timestamp: 4 },
      ];
      const view = render(<Fixture messages={messages} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      // Start at 0
      fireEvent.keyDown(transcript, { key: "j" });
      expect(transcript.dataset.focusedIndex).toBe("0");

      // Jump to next user turn (index 2)
      fireEvent.keyDown(transcript, { key: "n" });
      expect(transcript.dataset.focusedIndex).toBe("2");

      // Jump back to previous user turn (index 0)
      fireEvent.keyDown(transcript, { key: "p" });
      expect(transcript.dataset.focusedIndex).toBe("0");
      view.unmount();
    });

    it("triggers fork on focused message with f", async () => {
      const messages: UiMessage[] = [
        { id: "u1", role: "user", text: "Turn 1", timestamp: 1 },
      ];
      const onFork = vi.fn();
      const view = render(<Fixture messages={messages} onForkMessage={onFork} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      fireEvent.keyDown(transcript, { key: "j" });
      fireEvent.keyDown(transcript, { key: "f" });
      expect(onFork).toHaveBeenCalledWith(messages[0]);
      view.unmount();
    });

    it("jumps to top and bottom of transcript with g/G and Home/End", async () => {
      const messages: UiMessage[] = [
        { id: "m0", role: "user", text: "Zero", timestamp: 1 },
        { id: "m1", role: "assistant", text: "One", timestamp: 2 },
        { id: "m2", role: "user", text: "Two", timestamp: 3 },
        { id: "m3", role: "assistant", text: "Three", timestamp: 4 },
      ];
      const view = render(<Fixture messages={messages} />);
      const transcript = view.container.querySelector<HTMLElement>(".virtual-transcript")!;

      // Jump to bottom with G
      fireEvent.keyDown(transcript, { key: "G" });
      expect(transcript.dataset.focusedIndex).toBe("3");

      // Jump to top with g
      fireEvent.keyDown(transcript, { key: "g" });
      expect(transcript.dataset.focusedIndex).toBe("0");

      // Jump to bottom with End
      fireEvent.keyDown(transcript, { key: "End" });
      expect(transcript.dataset.focusedIndex).toBe("3");

      // Jump to top with Home
      fireEvent.keyDown(transcript, { key: "Home" });
      expect(transcript.dataset.focusedIndex).toBe("0");

      view.unmount();
    });
  });
});
