import { describe, expect, it } from "vitest";
import { placeFloating, pointRect } from "./floating";

const viewport = { width: 800, height: 600 };
const size = { width: 200, height: 100 };

describe("placeFloating", () => {
  it("sits on the preferred side, aligned as asked", () => {
    const anchor = { left: 100, top: 100, width: 40, height: 20 };
    expect(placeFloating(anchor, size, viewport, { side: "bottom", align: "start", offset: 4 })).toEqual({ left: 100, top: 124, side: "bottom" });
    expect(placeFloating(anchor, size, viewport, { side: "right", align: "center", offset: 4 })).toEqual({ left: 144, top: 60, side: "right" });
  });

  it("flips to the side with room when the preferred one has none", () => {
    const nearBottom = { left: 100, top: 560, width: 40, height: 20 };
    expect(placeFloating(nearBottom, size, viewport, { side: "bottom", offset: 4 }).side).toBe("top");
    const nearTop = { left: 100, top: 10, width: 40, height: 20 };
    expect(placeFloating(nearTop, size, viewport, { side: "top", offset: 4 }).side).toBe("bottom");
  });

  it("slides along the edge instead of leaving the window", () => {
    const placed = placeFloating(pointRect(790, 300), size, viewport, { side: "bottom", align: "start", padding: 8 });
    expect(placed.left).toBe(800 - 8 - 200);
    const left = placeFloating(pointRect(2, 300), size, viewport, { side: "bottom", align: "end", padding: 8 });
    expect(left.left).toBe(8);
  });

  it("moves to a side that leaves a region clear, such as the native window controls", () => {
    const avoid = { left: 0, top: 0, width: 80, height: 40 };
    const row = { left: 100, top: 45, width: 28, height: 28 };
    expect(placeFloating(row, { width: 100, height: 28 }, viewport, { side: "top", avoid }).side).toBe("bottom");
    // Without the region it stays on top, over the same corner.
    expect(placeFloating(row, { width: 100, height: 28 }, viewport, { side: "top" })).toMatchObject({ side: "top", top: 11 });
    // A float that already clears it stays where it was.
    expect(placeFloating({ ...row, left: 300 }, { width: 100, height: 28 }, viewport, { side: "top", avoid }).side).toBe("top");
  });

  it("tries the sides across when the opposite one has no room either", () => {
    const avoid = { left: 0, top: 0, width: 80, height: 40 };
    const anchor = { left: 100, top: 70, width: 28, height: 28 };
    const placed = placeFloating(anchor, { width: 100, height: 28 }, { width: 800, height: 120 }, { side: "top", avoid });
    expect(placed).toEqual({ side: "right", left: 134, top: 70 });
  });
});
