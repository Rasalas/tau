import { describe, expect, it } from "vitest";
import { centerLayout, toolPlace, type CenterLayoutInput } from "./center-layout";

/** A MacBook window: the default sidebar and a file open on the stage. */
const desk = (windowWidth: number, change: Partial<CenterLayoutInput> = {}) => centerLayout({
  windowWidth, sidebarWidth: 256, stageOpen: true, maximized: false, ...change,
});

const SIDE_BY_SIDE = { stageShown: true, tabs: false, canSplit: true };
const STACKED = { stageShown: true, tabs: true, canSplit: false };
const MAXIMIZED = { stageShown: true, tabs: true, canSplit: true };

describe("centerLayout", () => {
  it("shows no stage while it holds nothing, whatever the window", () => {
    expect(desk(1280, { stageOpen: false })).toEqual({ stageShown: false, tabs: false, canSplit: true });
    expect(desk(700, { stageOpen: false, maximized: true })).toEqual({ stageShown: false, tabs: false, canSplit: false });
  });

  it("keeps chat and stage side by side wherever both minimums fit beside the sidebar", () => {
    expect(desk(1920)).toEqual(SIDE_BY_SIDE);
    expect(desk(1280)).toEqual(SIDE_BY_SIDE);
    // 256 + chat 480 + stage 360
    expect(desk(1096)).toEqual(SIDE_BY_SIDE);
  });

  it("folds one of the two to its spine where the window is too narrow for both", () => {
    expect(desk(1095)).toEqual(STACKED);
    expect(desk(1095, { sidebarWidth: 0 })).toEqual(SIDE_BY_SIDE);
    expect(desk(390, { sidebarWidth: 0 })).toEqual(STACKED);
  });

  it("gives a tablet's narrower chat its own minimum", () => {
    expect(desk(1000, { sidebarWidth: 280, chatMin: 360 })).toEqual(SIDE_BY_SIDE);
    expect(desk(1000, { sidebarWidth: 280 })).toEqual(STACKED);
  });

  it("folds the conversation when the stage is maximized, and offers the way back only where it fits", () => {
    expect(desk(1728, { maximized: true })).toEqual(MAXIMIZED);
    expect(desk(1095, { maximized: true })).toEqual(STACKED);
  });

  it("draws a folded stage as its spine: no tabs shown, nothing stacked", () => {
    expect(desk(1440, { folded: true })).toEqual({ stageShown: false, tabs: false, canSplit: true });
    expect(desk(1440, { folded: true, maximized: true })).toEqual({ stageShown: false, tabs: false, canSplit: true });
  });
});

describe("toolPlace", () => {
  it("opens every tool as a stage tab", () => {
    expect(toolPlace({})).toBe("tab");
    expect(toolPlace({ placement: "dock" })).toBe("tab");
  });

  it("leaves a panel that asked for the drawer below the conversation and the stage", () => {
    expect(toolPlace({ placement: "drawer" })).toBe("drawer");
  });
});
