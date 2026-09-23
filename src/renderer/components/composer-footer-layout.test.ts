import { describe, expect, it } from "vitest";
import { fitFooterControls, type FooterMeasurement } from "./composer-footer-layout";

// Model chip 160; reasoning, access and stash blocks; an 28 px overflow trigger; 8 px gaps.
const measure = (available: number): FooterMeasurement => ({
  available,
  gap: 8,
  fixed: [160],
  blocks: [{ natural: 90, icon: 30 }, { natural: 100, icon: 30 }, { natural: 40, icon: 30 }],
  overflow: 28,
});

describe("fitFooterControls", () => {
  it("keeps every label when the row has room", () => {
    // 160 + 90 + 100 + 40 + 3 gaps
    expect(fitFooterControls(measure(414))).toEqual({ iconOnly: 0, hidden: 0 });
  });

  it("drops labels from the end first", () => {
    expect(fitFooterControls(measure(413))).toEqual({ iconOnly: 1, hidden: 0 });
    expect(fitFooterControls(measure(334))).toEqual({ iconOnly: 2, hidden: 0 });
    expect(fitFooterControls(measure(274))).toEqual({ iconOnly: 3, hidden: 0 });
  });

  it("then moves blocks into the overflow menu, the last one first", () => {
    // All icons: 160 + 30 * 3 + 3 gaps = 274; one hidden: 160 + 30 * 2 + 28 + 3 gaps = 272.
    expect(fitFooterControls(measure(273))).toEqual({ iconOnly: 3, hidden: 1 });
    expect(fitFooterControls(measure(234))).toEqual({ iconOnly: 3, hidden: 2 });
    expect(fitFooterControls(measure(100))).toEqual({ iconOnly: 3, hidden: 3 });
  });

  it("needs a pixel more to grow back than to shrink, so a width on the edge does not flip", () => {
    const shrunk = fitFooterControls(measure(413));
    expect(fitFooterControls(measure(414), shrunk)).toEqual(shrunk);
    expect(fitFooterControls(measure(415), shrunk)).toEqual({ iconOnly: 0, hidden: 0 });
    const hidden = fitFooterControls(measure(273));
    expect(fitFooterControls(measure(274), hidden)).toEqual(hidden);
    expect(fitFooterControls(measure(275), hidden)).toEqual({ iconOnly: 3, hidden: 0 });
  });

  it("has nothing to fold without blocks", () => {
    expect(fitFooterControls({ ...measure(10), blocks: [] })).toEqual({ iconOnly: 0, hidden: 0 });
  });
});
