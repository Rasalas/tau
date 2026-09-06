// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDomRect } from "./components/test-dom-geometry";
import {
  keepClearShift,
  publishStageBand,
  reserveRegion,
  reservedRegion,
  subscribeReservedRegion,
  useKeepClear,
} from "./reserved-region";

/** A dock-wide preview view on the right half of a 1000 px window. */
const PREVIEW = { left: 600, top: 100, right: 1000, bottom: 700 };

afterEach(() => {
  cleanup();
  reserveRegion(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});

describe("keepClearShift", () => {
  it("leaves a float that already misses the region alone", () => {
    expect(keepClearShift({ left: 100, top: 200, right: 300, bottom: 400 }, PREVIEW)).toBe(0);
    // Overlaps horizontally but sits above it, like a title-bar chip.
    expect(keepClearShift({ left: 700, top: 0, right: 900, bottom: 46 }, PREVIEW)).toBe(0);
  });

  it("slides a menu left until it clears the region, plus a gap", () => {
    // Right edge 8 px inside the region, so 8 + the 8 px gap.
    expect(keepClearShift({ left: 400, top: 200, right: 608, bottom: 400 }, PREVIEW)).toBe(16);
  });

  it("stays put when sliding would only push it off the other edge", () => {
    // 600 px wide from x=100: clearing the region would put its left at -8.
    expect(keepClearShift({ left: 100, top: 200, right: 700, bottom: 400 }, PREVIEW)).toBe(0);
  });

  it("does nothing when the host reserves nothing", () => {
    expect(keepClearShift({ left: 400, top: 200, right: 608, bottom: 400 }, undefined)).toBe(0);
  });
});

describe("reserveRegion", () => {
  it("notifies only when the rectangle actually changes", () => {
    const listener = vi.fn();
    const stop = subscribeReservedRegion(listener);

    reserveRegion(PREVIEW);
    reserveRegion({ ...PREVIEW });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reservedRegion()).toEqual(PREVIEW);

    reserveRegion(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reservedRegion()).toBeUndefined();
    stop();
  });
});

function Float({ open = true }: { open?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeepClear(ref, open);
  return <div ref={ref} data-testid="float" />;
}

function stubRects(rect: DOMRect): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
}

describe("useKeepClear", () => {
  beforeEach(() => reserveRegion(PREVIEW));

  it("marks and shifts a float that would land on the reserved region", () => {
    stubRects(testDomRect({ left: 400, top: 200, right: 608, width: 208, height: 200 }));
    const view = render(<Float />);
    const float = view.getByTestId("float");

    expect(float.classList.contains("keeps-clear")).toBe(true);
    expect(float.style.getPropertyValue("--keep-clear-x")).toBe("-16px");
  });

  it("leaves a float that misses the region at rest", () => {
    stubRects(testDomRect({ left: 100, top: 200, right: 300, width: 200, height: 200 }));
    const view = render(<Float />);

    expect(view.getByTestId("float").style.getPropertyValue("--keep-clear-x")).toBe("0px");
  });

  it("re-measures when the host reserves a different rectangle", () => {
    stubRects(testDomRect({ left: 400, top: 200, right: 608, width: 208, height: 200 }));
    const view = render(<Float />);
    const float = view.getByTestId("float");
    expect(float.style.getPropertyValue("--keep-clear-x")).toBe("-16px");

    reserveRegion(undefined);
    expect(float.style.getPropertyValue("--keep-clear-x")).toBe("0px");
  });

  it("does nothing while the float is closed", () => {
    stubRects(testDomRect({ left: 400, top: 200, right: 608, width: 208, height: 200 }));
    const view = render(<Float open={false} />);

    expect(view.getByTestId("float").classList.contains("keeps-clear")).toBe(false);
  });
});

describe("publishStageBand", () => {
  it("centres fixed floats on the column instead of the window", () => {
    vi.stubGlobal("innerWidth", 1440);
    const column = document.createElement("div");
    document.body.append(column);
    vi.spyOn(column, "getBoundingClientRect")
      .mockReturnValue(testDomRect({ left: 282, top: 46, right: 1074, width: 792, height: 800 }));

    const stop = publishStageBand(column);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--stage-left")).toBe("282px");
    // 1440 - 1074: the dock and its rail, where the preview view is drawn.
    expect(root.getPropertyValue("--stage-right")).toBe("366px");

    stop();
    expect(root.getPropertyValue("--stage-left")).toBe("");
    expect(root.getPropertyValue("--stage-right")).toBe("");
    column.remove();
  });

  it("follows the column when the dock is resized", () => {
    vi.stubGlobal("innerWidth", 1440);
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observers.push(callback); }
      observe(): void {}
      disconnect(): void {}
    });
    const column = document.createElement("div");
    const rect = vi.spyOn(column, "getBoundingClientRect")
      .mockReturnValue(testDomRect({ left: 282, right: 1074, width: 792 }));

    const stop = publishStageBand(column);
    rect.mockReturnValue(testDomRect({ left: 282, right: 1174, width: 892 }));
    observers.forEach((callback) => callback());

    expect(document.documentElement.style.getPropertyValue("--stage-right")).toBe("266px");
    stop();
  });
});
