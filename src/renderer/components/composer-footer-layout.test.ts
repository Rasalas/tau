import { describe, expect, it } from "vitest";
import { fitFooterControls, type FooterMeasurement } from "./composer-footer-layout";

// Model chip 160; reasoning, access and stash blocks; an 28 px overflow trigger; 8 px gaps.
const measure = (available: number): FooterMeasurement => ({
  available,
  gap: 8,
  fixed: [{ natural: 160, icon: 160 }],
  blocks: [{ natural: 90, icon: 30 }, { natural: 100, icon: 30 }, { natural: 40, icon: 30 }],
  overflow: 28,
});

describe("fitFooterControls", () => {
  it("keeps every label when the row has room", () => {
    // 160 + 90 + 100 + 40 + 3 gaps
    expect(fitFooterControls(measure(414))).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
  });

  it("drops labels from the end first", () => {
    expect(fitFooterControls(measure(413))).toEqual({ leadIcons: false, iconOnly: 1, hidden: 0, trailingIcons: false });
    expect(fitFooterControls(measure(334))).toEqual({ leadIcons: false, iconOnly: 2, hidden: 0, trailingIcons: false });
    expect(fitFooterControls(measure(274))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 0, trailingIcons: false });
  });

  it("then moves blocks into the overflow menu, the last one first", () => {
    // All icons: 160 + 30 * 3 + 3 gaps = 274; one hidden: 160 + 30 * 2 + 28 + 3 gaps = 272.
    expect(fitFooterControls(measure(273))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 1, trailingIcons: false });
    expect(fitFooterControls(measure(234))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 2, trailingIcons: false });
    expect(fitFooterControls(measure(100))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: false });
  });

  it("needs a pixel more to grow back than to shrink, so a width on the edge does not flip", () => {
    const shrunk = fitFooterControls(measure(413));
    expect(fitFooterControls(measure(414), shrunk)).toEqual(shrunk);
    expect(fitFooterControls(measure(415), shrunk)).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
    const hidden = fitFooterControls(measure(273));
    expect(fitFooterControls(measure(274), hidden)).toEqual(hidden);
    expect(fitFooterControls(measure(275), hidden)).toEqual({ leadIcons: false, iconOnly: 3, hidden: 0, trailingIcons: false });
  });

  it("has nothing to fold without blocks", () => {
    expect(fitFooterControls({ ...measure(10), blocks: [] })).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
  });

  describe("with a lead control that shrinks to its icon", () => {
    // A 110 px lead chip that is 32 px as an icon, before the model: 110 + 160 + 90 + 100 + 40 + 4 gaps = 532.
    const withLead = (available: number): FooterMeasurement => ({ ...measure(available), lead: [{ natural: 110, icon: 32 }] });

    it("keeps its label while the row has room", () => {
      expect(fitFooterControls(withLead(532))).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
    });

    it("shrinks it before any block drops its label", () => {
      // 32 + 160 + 90 + 100 + 40 + 4 gaps = 454
      expect(fitFooterControls(withLead(531))).toEqual({ leadIcons: true, iconOnly: 0, hidden: 0, trailingIcons: false });
      expect(fitFooterControls(withLead(454))).toEqual({ leadIcons: true, iconOnly: 0, hidden: 0, trailingIcons: false });
      expect(fitFooterControls(withLead(453))).toEqual({ leadIcons: true, iconOnly: 1, hidden: 0, trailingIcons: false });
    });

    it("keeps the icon while the blocks fold, and the blocks folded into the menu", () => {
      expect(fitFooterControls(withLead(100))).toEqual({ leadIcons: true, iconOnly: 3, hidden: 3, trailingIcons: false });
    });

    it("needs a pixel more to grow back, like the blocks", () => {
      const shrunk = fitFooterControls(withLead(531));
      expect(fitFooterControls(withLead(532), shrunk)).toEqual(shrunk);
      expect(fitFooterControls(withLead(533), shrunk)).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
    });

    it("takes its gap along when it leaves the row", () => {
      // A status control is 0 px once it left: 100 + 50 + 1 gap, so the send button keeps its words.
      expect(fitFooterControls({ available: 158, gap: 8, fixed: [{ natural: 100, icon: 100 }], lead: [{ natural: 60, icon: 0 }, { natural: 50, icon: 50 }], blocks: [], overflow: 0, trailingGain: 100 })).toEqual({ leadIcons: true, iconOnly: 0, hidden: 0, trailingIcons: false });
    });

    it("counts its gap with the other items", () => {
      expect(fitFooterControls({ available: 168, gap: 8, fixed: [{ natural: 100, icon: 100 }], lead: [{ natural: 60, icon: 20 }], blocks: [], overflow: 0 })).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
      expect(fitFooterControls({ available: 167, gap: 8, fixed: [{ natural: 100, icon: 100 }], lead: [{ natural: 60, icon: 20 }], blocks: [], overflow: 0 })).toEqual({ leadIcons: true, iconOnly: 0, hidden: 0, trailingIcons: false });
    });
  });

  describe("with a trailing label outside the row", () => {
    // The send button's 110 px label: hiding it gives the row that much more room.
    const withTrailing = (available: number): FooterMeasurement => ({ ...measure(available), trailingGain: 110 });

    it("keeps it while the folded row fits", () => {
      // Folded: the model and the overflow trigger, 160 + 28 + 8 = 196.
      expect(fitFooterControls(withTrailing(196))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: false });
    });

    it("drops it once even the folded row is too wide", () => {
      // Folded: the model and the overflow trigger, 160 + 28 + 8 = 196.
      const folded = { ...withTrailing(195), fixed: [{ natural: 160, icon: 160 }] };
      expect(fitFooterControls(folded)).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: true });
    });

    it("needs a pixel more to take it back", () => {
      const at = (available: number) => ({ ...withTrailing(available), fixed: [{ natural: 160, icon: 160 }] });
      const shrunk = fitFooterControls(at(195));
      expect(fitFooterControls(at(196), shrunk)).toEqual(shrunk);
      expect(fitFooterControls(at(197), shrunk)).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: false });
    });

    it("lets the model shorten before it drops", () => {
      // The model shortens to 64 px: folded, 64 + 28 + 8 = 100 fits where its 160 px name does not.
      const shortening = (available: number) => ({ ...withTrailing(available), fixed: [{ natural: 160, icon: 160, min: 64 }] });
      expect(fitFooterControls(shortening(100))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: false });
      expect(fitFooterControls(shortening(99))).toEqual({ leadIcons: false, iconOnly: 3, hidden: 3, trailingIcons: true });
    });

    it("is not a step without a gain", () => {
      expect(fitFooterControls({ ...measure(10), blocks: [], trailingGain: 0 })).toEqual({ leadIcons: false, iconOnly: 0, hidden: 0, trailingIcons: false });
    });
  });
});
