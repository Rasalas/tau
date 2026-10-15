// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetDragCloses, sheetDragMayStart, sheetDragRest, useSheetDrag } from "./sheet-drag";

beforeEach(() => { vi.useFakeTimers({ toFake: ["performance"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** `heights` lays the sheet out at a medium and a large detent, as sheet.css does on a phone. */
function Sheet({ onClose, scrollTop = 0, heights }: { onClose(): void; scrollTop?: number; heights?: { medium: number; large: number } }) {
  const ref = useRef<HTMLElement>(null);
  useSheetDrag(ref, onClose);
  return <section aria-label="sheet" ref={(node) => {
    ref.current = node;
    if (!node || !heights) return;
    Object.defineProperty(node, "offsetHeight", { configurable: true, get: () => node.hasAttribute("data-sheet-expanded") ? heights.large : heights.medium });
  }}>
    <header>Title</header>
    <div data-testid="list" style={{ overflowY: "auto" }} ref={(node) => {
      if (!node) return;
      Object.defineProperty(node, "scrollHeight", { value: 900, configurable: true });
      Object.defineProperty(node, "clientHeight", { value: 300, configurable: true });
      node.scrollTop = scrollTop;
    }}>rows</div>
    <button onClick={onClose}>Choose project</button>
    <input aria-label="field" />
  </section>;
}

const pull = (target: Element, from: number, to: number, steps = 4, ms = 40) => {
  fireEvent.touchStart(target, { touches: [{ clientY: from }] });
  for (let step = 1; step <= steps; step += 1) {
    vi.advanceTimersByTime(ms);
    fireEvent.touchMove(target, { touches: [{ clientY: from + ((to - from) * step) / steps }] });
  }
  fireEvent.touchEnd(target, { touches: [] });
};

describe("pulling a sheet down", () => {
  it("closes on a long or a fast pull, never on a short one", () => {
    expect(sheetDragCloses(120, 0.1)).toBe(true);
    expect(sheetDragCloses(40, 0.9)).toBe(true);
    expect(sheetDragCloses(40, 0.2)).toBe(false);
    expect(sheetDragCloses(12, 3)).toBe(false);
  });

  it("leaves a pull that starts on a field, or over selected text, to that control", () => {
    document.body.innerHTML = "<div><button><span id=inner>x</span></button><p id=free>text</p></div>";
    expect(sheetDragMayStart(document.getElementById("inner")!, null)).toBe(true);
    expect(sheetDragMayStart(document.getElementById("free")!, null)).toBe(true);
    expect(sheetDragMayStart(document.getElementById("free")!, { isCollapsed: false } as Selection)).toBe(false);
  });

  it("follows a pull on the header and closes past the threshold", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    pull(screen.getByText("Title"), 100, 180, 4, 200);
    expect(onClose).not.toHaveBeenCalled();
    pull(screen.getByText("Title"), 100, 260, 4, 200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets the list scroll while it can, and only then pulls the sheet", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} scrollTop={200} />);
    pull(screen.getByTestId("list"), 100, 400);
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
    render(<Sheet onClose={onClose} scrollTop={0} />);
    pull(screen.getByTestId("list"), 100, 400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls from a button without activating it after a short drag", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    const button = screen.getByRole("button", { name: "Choose project" });
    pull(button, 100, 160, 4, 200);
    fireEvent.click(button);
    expect(onClose).not.toHaveBeenCalled();
    pull(button, 100, 400);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels a long pull without closing", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    const title = screen.getByText("Title");
    fireEvent.touchStart(title, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(title, { touches: [{ clientY: 120 }] });
    fireEvent.touchMove(title, { touches: [{ clientY: 300 }] });
    fireEvent.touchCancel(title);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("sheet").style.transform).toBe("");
  });

  it("does not close from a field", () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} />);
    pull(screen.getByLabelText("field"), 100, 400);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a sheet with a medium and a large detent", () => {
  const heights = { medium: 400, large: 700 };
  const sheet = () => screen.getByLabelText("sheet");

  it("goes to the nearer detent unless the pull was long or fast", () => {
    // From medium (rests at 300) and from full height (0).
    expect(sheetDragRest(300, 140, -0.1, 300)).toBe(0);
    expect(sheetDragRest(300, 230, -0.1, 300)).toBe(300);
    expect(sheetDragRest(300, 230, -0.9, 300)).toBe(0);
    expect(sheetDragRest(300, 200, -0.1, 300)).toBe(0);
    expect(sheetDragRest(300, 340, 0.1, 300)).toBe(300);
    expect(sheetDragRest(0, 60, 0.1, 300)).toBe(0);
    expect(sheetDragRest(0, 60, 0.9, 300)).toBe(300);
    expect(sheetDragRest(0, 200, 0.1, 300)).toBe(300);
    expect(sheetDragRest(0, 330, 0.9, 300)).toBeUndefined();
    // Content that fits medium has one rest.
    expect(sheetDragRest(0, 40, 0.1, 0)).toBe(0);
    expect(sheetDragRest(0, 120, 0.1, 0)).toBeUndefined();
  });

  it("grows to large on a pull up, before its list scrolls", () => {
    render(<Sheet onClose={vi.fn()} heights={heights} />);
    const list = screen.getByTestId("list");
    fireEvent.touchStart(list, { touches: [{ clientX: 50, clientY: 300 }] });
    expect(fireEvent.touchMove(list, { touches: [{ clientX: 50, clientY: 297 }] })).toBe(false);
    for (const y of [260, 200]) fireEvent.touchMove(list, { touches: [{ clientX: 50, clientY: y }] });
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(true);
    // It follows from where the pull passed the slop.
    expect(sheet().style.transform).toBe("translateY(240px)");
    fireEvent.touchEnd(list, { touches: [] });
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(true);
    expect(sheet().style.transform).toBe("");
  });

  it("springs back to medium after a short pull up", () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    render(<Sheet onClose={vi.fn()} heights={heights} />);
    pull(screen.getByText("Title"), 300, 260, 4, 200);
    expect(sheet().style.transform).toBe("translateY(300px)");
    vi.advanceTimersByTime(200);
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(false);
    expect(sheet().style.transform).toBe("");
  });

  it("goes from large back to medium, and only a further pull closes it", () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const onClose = vi.fn();
    render(<Sheet onClose={onClose} heights={heights} />);
    pull(screen.getByText("Title"), 300, 100, 4, 40);
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(true);
    pull(screen.getByText("Title"), 100, 300, 4, 200);
    vi.advanceTimersByTime(200);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(false);
    pull(screen.getByText("Title"), 100, 300, 4, 200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays one height when its content fits medium", () => {
    render(<Sheet onClose={vi.fn()} heights={{ medium: 400, large: 400 }} />);
    const list = screen.getByTestId("list");
    fireEvent.touchStart(list, { touches: [{ clientX: 50, clientY: 300 }] });
    expect(fireEvent.touchMove(list, { touches: [{ clientX: 50, clientY: 290 }] })).toBe(true);
    fireEvent.touchMove(list, { touches: [{ clientX: 50, clientY: 200 }] });
    fireEvent.touchEnd(list, { touches: [] });
    expect(sheet().hasAttribute("data-sheet-expanded")).toBe(false);
  });
});
