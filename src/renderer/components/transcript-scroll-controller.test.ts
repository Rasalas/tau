// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptNavigationState } from "../../workbench/transcript-navigation";
import {
  FrameLoop,
  JUMP_SHOW_DISTANCE_PX,
  jumpToLatestVisible,
  nearTranscriptStart,
  nearTranscriptTail,
  scrollToTail,
  ScrollIntentTracker,
  TranscriptScrollController,
  transcriptScrollMode,
} from "./transcript-scroll-controller";

const messages: UiMessage[] = [
  { id: "a", role: "user", text: "First", timestamp: 1 },
  { id: "b", role: "assistant", text: "Answer", timestamp: 2 },
  { id: "c", role: "user", text: "Second", timestamp: 3 },
];

function state(overrides: Partial<TranscriptNavigationState> = {}): TranscriptNavigationState {
  return {
    anchorPending: false,
    anchorLocked: false,
    anchorSuppressed: false,
    following: true,
    touchActive: false,
    pointerDown: false,
    ...overrides,
  };
}

interface Harness {
  node: HTMLDivElement;
  controller: TranscriptScrollController;
  navigation: TranscriptNavigationState;
  anchors: Array<string | undefined>;
  jumps: boolean[];
  frame(): Promise<void>;
  dispose(): void;
}

function harness(navigation: TranscriptNavigationState, scrollHeight = 1_000, clientHeight = 200): Harness {
  const node = document.createElement("div");
  document.body.append(node);
  Object.defineProperties(node, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  const anchors: Array<string | undefined> = [];
  const jumps: boolean[] = [];
  const controller = new TranscriptScrollController(navigation, {
    getNode: () => node,
    getMessages: () => messages,
    getLookup: () => undefined,
    onAnchorChange: (id) => anchors.push(id),
    onJumpAvailabilityChange: (canJump) => jumps.push(canJump),
  });
  controller.attach(node);
  return {
    node,
    controller,
    navigation,
    anchors,
    jumps,
    frame: () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }),
    dispose: () => { controller.detach(); node.remove(); },
  };
}

function addRow(node: HTMLDivElement, messageId: string, top: number, height: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "virtual-transcript-row";
  row.dataset.messageId = messageId;
  row.style.transform = `translateY(${top}px)`;
  row.getBoundingClientRect = () => ({
    x: 0, y: top - node.scrollTop, top: top - node.scrollTop, left: 0, right: 780,
    bottom: top - node.scrollTop + height, width: 780, height, toJSON: () => ({}),
  });
  node.append(row);
  return row;
}

afterEach(() => { document.body.replaceChildren(); });

describe("transcript scroll mode", () => {
  it("maps navigation state onto the three explicit modes", () => {
    expect(transcriptScrollMode(state())).toBe("tail");
    expect(transcriptScrollMode(state({ anchorPending: true }))).toBe("anchored");
    expect(transcriptScrollMode(state({ anchorLocked: true }))).toBe("anchored");
    expect(transcriptScrollMode(state({ following: false }))).toBe("free");
  });
});

describe("transcript scroll ends", () => {
  const surface = (scrollTop: number, scrollHeight = 1_000, clientHeight = 200) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it("counts the last pixels of a transcript as its tail", () => {
    // The maximum here is 800, so the tail is the last 31px of scroll.
    expect(nearTranscriptTail(surface(768))).toBe(false);
    expect(nearTranscriptTail(surface(769))).toBe(true);
    expect(nearTranscriptTail(surface(800))).toBe(true);
    // Content that cannot scroll is at both ends at once.
    expect(nearTranscriptTail(surface(0, 150, 200))).toBe(true);
  });

  it("counts the first pixels of a transcript as its start", () => {
    expect(nearTranscriptStart(surface(0))).toBe(true);
    expect(nearTranscriptStart(surface(32))).toBe(true);
    expect(nearTranscriptStart(surface(33))).toBe(false);
  });

  it("leaves a transcript already at its tail unwritten", () => {
    let writes = 0;
    let top = 800.5;
    const node = { get scrollTop() { return top; }, set scrollTop(value: number) { writes += 1; top = value; }, scrollHeight: 1_000, clientHeight: 200 };
    scrollToTail(node);
    expect(writes).toBe(0);
    top = 700;
    scrollToTail(node);
    expect(writes).toBe(1);
  });
});

describe("Jump to latest hysteresis", () => {
  const surface = (distance: number) => ({ scrollTop: 800 - distance, scrollHeight: 1_000, clientHeight: 200 });

  it("appears only well away from the tail", () => {
    expect(jumpToLatestVisible(surface(0), false, false)).toBe(false);
    expect(jumpToLatestVisible(surface(JUMP_SHOW_DISTANCE_PX), false, false)).toBe(false);
    expect(jumpToLatestVisible(surface(JUMP_SHOW_DISTANCE_PX + 1), false, false)).toBe(true);
  });

  it("stays between the show and hide distances and leaves at the tail", () => {
    expect(jumpToLatestVisible(surface(60), false, true)).toBe(true);
    expect(jumpToLatestVisible(surface(32), false, true)).toBe(true);
    expect(jumpToLatestVisible(surface(31), false, true)).toBe(false);
    expect(jumpToLatestVisible(surface(0), false, true)).toBe(false);
  });

  it("never shows while following or without overflow", () => {
    expect(jumpToLatestVisible(surface(400), true, true)).toBe(false);
    expect(jumpToLatestVisible({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 }, false, true)).toBe(false);
  });

  it("does not flip when its own row moves the tail by the row's height", () => {
    const row = 40;
    // Just past the show distance, the row appears and the viewport gets shorter.
    expect(jumpToLatestVisible(surface(JUMP_SHOW_DISTANCE_PX + 1 + row), false, true)).toBe(true);
    // Just inside the hide distance, the row leaves and the viewport gets taller.
    expect(jumpToLatestVisible(surface(Math.max(0, 31 - row)), false, false)).toBe(false);
  });
});

describe("FrameLoop", () => {
  it("keeps at most one frame in flight and cancels it on demand", async () => {
    const loop = new FrameLoop();
    const run = vi.fn();
    loop.schedule(run);
    loop.schedule(run);
    expect(loop.pending).toBe(true);
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.pending).toBe(false);

    loop.schedule(run);
    loop.cancel();
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a layout-settling callback on the second frame only", async () => {
    const loop = new FrameLoop();
    const run = vi.fn();
    loop.scheduleAfterLayout(run);
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    expect(run).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("ScrollIntentTracker", () => {
  it("expires an armed intent without leaving a timer behind", () => {
    vi.useFakeTimers();
    try {
      const tracker = new ScrollIntentTracker();
      tracker.arm("older");
      expect(tracker.intent).toBe("older");
      vi.advanceTimersByTime(200);
      expect(tracker.intent).toBeUndefined();
      expect(tracker.armed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TranscriptScrollController", () => {
  it("pins the tail in tail mode", async () => {
    const test = harness(state());
    try {
      test.controller.sync();
      await test.frame();
      expect(test.node.scrollTop).toBe(1_000);
      expect(test.controller.mode).toBe("tail");
    } finally {
      test.dispose();
    }
  });

  it("places and then holds an anchored row while content grows below it", async () => {
    const test = harness(state({ anchorId: "c", anchorPending: true }), 1_000, 600);
    try {
      addRow(test.node, "a", 0, 100);
      addRow(test.node, "c", 300, 100);
      test.controller.sync();
      await test.frame();
      expect(test.node.scrollTop).toBe(300);
      expect(test.controller.mode).toBe("anchored");

      // The row drifts as content above is measured; the controller pulls it back.
      test.node.scrollTop = 260;
      test.controller.sync();
      await test.frame();
      expect(test.node.scrollTop).toBe(300);
    } finally {
      test.dispose();
    }
  });

  it("leaves the transcript alone in free mode and offers the jump action", async () => {
    const test = harness(state());
    try {
      test.node.scrollTop = 400;
      test.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      expect(test.controller.mode).toBe("free");
      test.controller.sync();
      await test.frame();
      expect(test.node.scrollTop).toBe(400);
      expect(test.jumps.at(-1)).toBe(true);
    } finally {
      test.dispose();
    }
  });

  it("returns to tail mode from the jump action and clears the anchor", async () => {
    const test = harness(state({ following: false, anchorId: "c" }));
    try {
      test.node.scrollTop = 100;
      test.controller.jumpToLatest();
      expect(test.controller.mode).toBe("tail");
      expect(test.anchors.at(-1)).toBeUndefined();
      await test.frame();
      expect(test.node.scrollTop).toBe(1_000);
      expect(test.jumps.at(-1)).toBe(false);
    } finally {
      test.dispose();
    }
  });

  it("lands turn navigation on the row and stays free while it streams", async () => {
    const test = harness(state(), 1_000, 600);
    try {
      addRow(test.node, "a", 0, 100);
      addRow(test.node, "c", 420, 100);
      test.controller.jumpToMessage("c");
      expect(test.node.scrollTop).toBe(400);
      expect(test.controller.mode).toBe("free");
      test.controller.sync();
      await test.frame();
      expect(test.node.scrollTop).toBe(400);
    } finally {
      test.dispose();
    }
  });

  it("ignores a layout scroll event that carries no user intent", () => {
    const test = harness(state());
    try {
      test.node.scrollTop = 300;
      test.node.dispatchEvent(new Event("scroll"));
      expect(test.controller.mode).toBe("tail");
    } finally {
      test.dispose();
    }
  });

  it("notifies extra scroll consumers through the single listener", () => {
    const test = harness(state());
    const listener = vi.fn();
    try {
      const unsubscribe = test.controller.subscribeScroll(listener);
      test.node.dispatchEvent(new Event("scroll"));
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      test.node.dispatchEvent(new Event("scroll"));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      test.dispose();
    }
  });

  it("does not read the browser pulling the offset into a taller viewport as the reader scrolling up", () => {
    const test = harness(state());
    try {
      let clientHeight = 200;
      Object.defineProperty(test.node, "clientHeight", { configurable: true, get: () => clientHeight });
      test.node.scrollTop = 800;
      test.node.dispatchEvent(new Event("scroll"));
      test.node.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      // A row under the transcript went away: the viewport grew and the browser clamped the offset.
      clientHeight = 240;
      test.node.scrollTop = 760;
      test.node.dispatchEvent(new Event("scroll"));
      expect(test.controller.mode).toBe("tail");
      expect(test.jumps.filter(Boolean)).toEqual([]);
    } finally {
      test.dispose();
    }
  });

  it("settles a fling that runs past the end without toggling Jump to latest", () => {
    // A layout like the real one: the jump row takes 36px from the viewport,
    // and the browser clamps the offset when that changes the maximum.
    const node = document.createElement("div");
    document.body.append(node);
    let jumpShown = false;
    let top = 0;
    const scrollHeight = 2_000;
    const clientHeight = () => (jumpShown ? 364 : 400);
    const max = () => scrollHeight - clientHeight();
    Object.defineProperties(node, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: clientHeight },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(max(), value)); } },
    });
    // The row renders and lays out a frame later, after that frame's wheel event.
    let layoutPending = false;
    const layout = () => {
      if (!layoutPending) return;
      layoutPending = false;
      if (top <= max()) return;
      top = max();
      node.dispatchEvent(new Event("scroll"));
    };
    const toggles: boolean[] = [];
    const controller = new TranscriptScrollController(state({ following: false }), {
      getNode: () => node,
      getMessages: () => messages,
      getLookup: () => undefined,
      onAnchorChange: () => {},
      onJumpAvailabilityChange: (canJump) => {
        if (canJump === jumpShown) return;
        jumpShown = canJump;
        toggles.push(canJump);
        layoutPending = true;
      },
    });
    controller.attach(node);
    try {
      node.scrollTop = 1_000;
      node.dispatchEvent(new Event("scroll"));
      layout();
      expect(toggles).toEqual([true]);

      // Momentum, one wheel event a frame: the deltas decay and keep coming well after the end.
      for (let delta = 90; delta >= 1; delta *= 0.94) {
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: delta }));
        layout();
        const before = top;
        node.scrollTop = top + delta;
        if (top !== before) node.dispatchEvent(new Event("scroll"));
      }

      expect(toggles).toEqual([true, false]);
      expect(controller.mode).toBe("tail");
      expect(top).toBe(max());
    } finally {
      controller.detach();
      node.remove();
    }
  });

  it("puts a tail-mode transcript back at its end before paint when its viewport shrinks", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    let clientHeight = 200;
    const test = harness(state());
    try {
      Object.defineProperty(test.node, "clientHeight", { configurable: true, get: () => clientHeight });
      test.node.scrollTop = 800;
      clientHeight = 148;
      observers[0]!();
      expect(test.node.scrollTop).toBe(1_000);
    } finally {
      test.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("stops reacting to events and frames after detach", async () => {
    const test = harness(state());
    try {
      test.controller.sync();
      test.controller.detach();
      await test.frame();
      expect(test.node.scrollTop).toBe(0);
      test.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      expect(test.controller.mode).toBe("tail");
    } finally {
      test.dispose();
    }
  });
});
