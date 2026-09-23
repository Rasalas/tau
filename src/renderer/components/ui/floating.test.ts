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
});
