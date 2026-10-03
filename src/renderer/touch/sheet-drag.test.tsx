// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetDragCloses, sheetDragMayStart, useSheetDrag } from "./sheet-drag";

beforeEach(() => { vi.useFakeTimers({ toFake: ["performance"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Sheet({ onClose, scrollTop = 0 }: { onClose(): void; scrollTop?: number }) {
  const ref = useRef<HTMLElement>(null);
  useSheetDrag(ref, onClose);
  return <section ref={ref} aria-label="sheet">
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
