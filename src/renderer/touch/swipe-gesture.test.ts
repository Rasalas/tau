import { describe, expect, it } from "vitest";
import { swipeAxis, swipeCommitDistance, swipeOffset, swipeRelease, swipeTrayWidth } from "./swipe-gesture";

describe("a row's swipe", () => {
  const tray = swipeTrayWidth(2);
  const row = 358;

  it("opens the tray past 42 % of it and runs the first action past the commit line", () => {
    expect(tray).toBe(116);
    expect(swipeCommitDistance(tray, row)).toBeCloseTo(207.64);
    expect(swipeRelease(-40, tray, row)).toBe("close");
    expect(swipeRelease(-50, tray, row)).toBe("open");
    expect(swipeRelease(-200, tray, row)).toBe("open");
    expect(swipeRelease(-210, tray, row)).toBe("commit");
    expect(swipeRelease(-300, 0, row)).toBe("close");
  });

  it("picks an axis only after the finger moved, and a vertical start is a scroll", () => {
    expect(swipeAxis(4, 3)).toBe("pending");
    expect(swipeAxis(-12, 4)).toBe("horizontal");
    expect(swipeAxis(-6, 11)).toBe("vertical");
  });

  it("never moves the row right of rest or past its own width", () => {
    expect(swipeOffset(0, 30, row)).toBe(0);
    expect(swipeOffset(-116, 20, row)).toBe(-96);
    expect(swipeOffset(0, -900, row)).toBe(-row);
  });
});
