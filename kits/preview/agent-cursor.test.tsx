// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCursorLayer, CURSOR_ACTIVE_MS, LABEL_VISIBLE_MS, chord, cursorMark, describeAction } from "./agent-cursor.js";
import type { ScreenAction } from "./screen-protocol.js";

const space = { width: 1000, height: 500 };
const click = (id: string, x: number, y: number, extra: Partial<ScreenAction> = {}): ScreenAction =>
  ({ id, kind: "click", at: 0, point: { x, y }, space, status: "done", ...extra });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the agent cursor's marks", () => {
  it("places the newest input as fractions of the picture", () => {
    expect(cursorMark([click("a", 250, 100)])).toMatchObject({ id: "a", kind: "click", at: { x: 0.25, y: 0.2 } });
    expect(cursorMark([{ id: "d", kind: "drag", at: 0, point: { x: 0, y: 0 }, to: { x: 1000, y: 500 }, space, status: "running" }]))
      .toMatchObject({ at: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    expect(cursorMark([])).toBeUndefined();
  });

  it("keeps the cursor at the last click while a chord or text without a place comes after it", () => {
    const mark = cursorMark([click("a", 500, 250), { id: "k", kind: "key", at: 0, keys: ["cmd", "shift", "4"], status: "done" }]);
    expect(mark).toMatchObject({ id: "k", at: { x: 0.5, y: 0.5 }, label: "⌘⇧4" });
    expect(mark?.to).toBeUndefined();
  });

  it("uses the frame's size when the action carries none, and places nothing without either", () => {
    const bare: ScreenAction = { id: "a", kind: "click", at: 0, point: { x: 10, y: 10 }, status: "done" };
    expect(cursorMark([bare], { width: 100, height: 20 })?.at).toEqual({ x: 0.1, y: 0.5 });
    expect(cursorMark([bare])?.at).toBeUndefined();
  });

  it("words every kind of input", () => {
    expect(describeAction(click("a", 0, 0))).toBe("Clicked");
    expect(describeAction(click("a", 0, 0, { status: "failed" }))).toBe("Clicked (failed)");
    expect(describeAction({ id: "t", kind: "type", at: 0, text: "hello", status: "done" })).toBe("Typed “hello”");
    expect(describeAction({ id: "k", kind: "key", at: 0, keys: ["return"], status: "done" })).toBe("Pressed ↩");
    expect(describeAction({ id: "s", kind: "scroll", at: 0, direction: "down", status: "done" })).toBe("Scrolled down");
    expect(chord(["ctrl", "option", "a"])).toBe("⌃⌥A");
  });
});

describe("AgentCursorLayer", () => {
  it("draws the cursor bright with a ring, then dims it; typed text stays a little longer", () => {
    vi.useFakeTimers();
    const typed: ScreenAction = { id: "t", kind: "type", at: 0, text: "hello e24", point: { x: 300, y: 426 }, space: { width: 1280, height: 1408 }, status: "done" };
    const { container, rerender } = render(<AgentCursorLayer actions={[click("a", 500, 250)]} />);
    const cursor = () => container.querySelector<HTMLElement>(".agent-cursor")!;

    expect(cursor().style.left).toBe("50%");
    expect(cursor().style.opacity).toBe("1");
    expect(container.querySelector(".agent-cursor-ping")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(CURSOR_ACTIVE_MS); });
    expect(cursor().style.opacity).toBe("0.35");
    expect(container.querySelector(".agent-cursor-ping")).toBeNull();

    rerender(<AgentCursorLayer actions={[click("a", 500, 250), typed]} />);
    expect(container.querySelector(".agent-cursor-label")?.textContent).toBe("hello e24");
    act(() => { vi.advanceTimersByTime(LABEL_VISIBLE_MS); });
    expect(container.querySelector(".agent-cursor-label")).toBeNull();
  });

  it("shows a chord in the corner when no input was placed yet", () => {
    const { container } = render(<AgentCursorLayer actions={[{ id: "k", kind: "key", at: 0, keys: ["cmd", "c"], status: "done" }]} />);
    expect(container.querySelector(".agent-cursor")).toBeNull();
    expect(container.querySelector(".agent-cursor-label.corner")?.textContent).toBe("⌘C");
  });
});
