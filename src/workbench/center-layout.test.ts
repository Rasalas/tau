import { describe, expect, it } from "vitest";
import { centerLayout, toolPlace, type CenterLayoutInput } from "./center-layout";

/** A MacBook window: default sidebar, the dock open at its default width, a file open. */
const desk = (windowWidth: number, change: Partial<CenterLayoutInput> = {}) => centerLayout({
  windowWidth, sidebarWidth: 256, dock: { open: true, width: 320 }, stageOpen: true, keepDock: false, maximized: false, ...change,
});

const SIDE_BY_SIDE = { dockYields: false, tabs: false, canSplit: true };
const ON_RAIL = { dockYields: true, tabs: false, canSplit: true };
const TABS = { dockYields: false, tabs: true, canSplit: false };
const MAXIMIZED = { dockYields: false, tabs: true, canSplit: true };

describe("centerLayout", () => {
  it("leaves everything as it is while no stage tab is open", () => {
    expect(desk(1080, { stageOpen: false })).toEqual(SIDE_BY_SIDE);
    expect(desk(1080, { stageOpen: false, maximized: true })).toEqual(SIDE_BY_SIDE);
  });

  it("keeps chat and stage side by side, with the dock open, where the stage gets its reading width", () => {
    expect(desk(1920)).toEqual(SIDE_BY_SIDE);
    expect(desk(1728)).toEqual(SIDE_BY_SIDE);
    // 256 + 46 + 320 + chat 480 + stage 560
    expect(desk(1662)).toEqual(SIDE_BY_SIDE);
  });

  it("folds the dock to its rail as soon as the stage would be narrower than its reading width", () => {
    expect(desk(1661)).toEqual(ON_RAIL);
    expect(desk(1512)).toEqual(ON_RAIL);
    expect(desk(1440)).toEqual(ON_RAIL);
    // Short of its reading width even on the rail (stage 498), but beside the chat.
    expect(desk(1280)).toEqual(ON_RAIL);
    expect(desk(1142)).toEqual(ON_RAIL);
  });

  it("makes the chat a tab only where even the rail leaves too little room", () => {
    expect(desk(1141)).toEqual(TABS);
    expect(desk(1141, { sidebarWidth: 0 })).toEqual(ON_RAIL);
    expect(desk(390, { sidebarWidth: 0, dock: undefined })).toEqual(TABS);
  });

  it("leaves the dock open once the user opened it with the stage up, beside the chat where both still fit, else in tabs", () => {
    expect(desk(1512, { keepDock: true })).toEqual(SIDE_BY_SIDE);
    expect(desk(1440, { keepDock: true })).toEqual(TABS);
  });

  it("leaves the dock open where the sidebar is hidden and the stage has its reading width anyway", () => {
    expect(desk(1512, { sidebarWidth: 0 })).toEqual(SIDE_BY_SIDE);
    expect(desk(1280, { sidebarWidth: 0 })).toEqual(ON_RAIL);
  });

  it("counts a closed dock as its rail, and no dock as nothing", () => {
    expect(desk(1142, { dock: { open: false, width: 320 } })).toEqual(SIDE_BY_SIDE);
    expect(desk(1096, { dock: undefined })).toEqual(SIDE_BY_SIDE);
    expect(desk(1095, { dock: undefined })).toEqual(TABS);
  });

  it("knows the stylesheet shows only the rail in a narrow window", () => {
    expect(desk(1040, { sidebarWidth: 0 })).toEqual(SIDE_BY_SIDE);
    expect(desk(1040)).toEqual(TABS);
  });

  it("follows a wider dock and a wider sidebar", () => {
    expect(desk(1920, { dock: { open: true, width: 560 } })).toEqual(SIDE_BY_SIDE);
    expect(desk(1728, { dock: { open: true, width: 560 } })).toEqual(ON_RAIL);
    expect(desk(1512, { sidebarWidth: 700 })).toEqual(TABS);
  });

  it("maximizes into the same tabs, the dock left as it was, and offers the way back only where it fits", () => {
    expect(desk(1728, { maximized: true })).toEqual(MAXIMIZED);
    expect(desk(1512, { maximized: true })).toEqual(MAXIMIZED);
    expect(desk(1440, { maximized: true })).toEqual(MAXIMIZED);
    expect(desk(1141, { maximized: true })).toEqual(TABS);
  });
});

describe("toolPlace", () => {
  const wide = { width: "wide", maximizable: true } as const;

  it("puts a wide tool beside the chat while nothing else is on the stage", () => {
    expect(toolPlace({ ...wide, stageOpen: false, maximized: false })).toBe("beside");
  });

  it("makes a wide tool a tab whenever the centre shows tabs: an open stage, or a maximized one", () => {
    expect(toolPlace({ ...wide, stageOpen: true, maximized: false })).toBe("tab");
    expect(toolPlace({ ...wide, stageOpen: true, maximized: true })).toBe("tab");
    expect(toolPlace({ ...wide, stageOpen: false, maximized: true })).toBe("tab");
  });

  it("keeps a wide tool that may not move onto the stage beside the chat", () => {
    expect(toolPlace({ width: "wide", stageOpen: true, maximized: false })).toBe("beside");
  });

  it("leaves lists to the dock and drawer panels to the drawer, stage or not", () => {
    for (const stageOpen of [false, true]) {
      expect(toolPlace({ maximizable: true, stageOpen, maximized: false })).toBe("list");
      expect(toolPlace({ width: "narrow", maximizable: true, stageOpen, maximized: true })).toBe("list");
      expect(toolPlace({ ...wide, placement: "drawer", stageOpen, maximized: false })).toBe("drawer");
    }
  });
});
