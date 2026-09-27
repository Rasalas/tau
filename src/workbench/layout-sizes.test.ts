import { describe, expect, it } from "vitest";
import {
  DOCK_MIN_WIDTH, DOCKED_CONTENT_MIN_WIDTH, dockMaxWidth, drawerMaxHeight, shownDockWidth, shownDrawerHeight, shownSidebarWidth, sidebarMaxWidth, storedDrawerHeight, storedSidebarWidth,
} from "./layout-sizes";
import { CHAT_MIN_WIDTH, DOCK_RAIL_WIDTH } from "./center-layout";

describe("layout sizes", () => {
  it("sizes the sidebar as T3 Code does: 256 by default, 208 at least, 640 left for the rest", () => {
    expect(storedSidebarWidth(null)).toBe(256);
    expect(storedSidebarWidth("garbage")).toBe(256);
    expect(storedSidebarWidth("120")).toBe(208);
    expect(storedSidebarWidth("311.6")).toBe(312);
    expect(sidebarMaxWidth(1440)).toBe(800);
    expect(sidebarMaxWidth(700)).toBe(208);
    expect(shownSidebarWidth(900, 1440)).toBe(800);
    expect(shownSidebarWidth(300, 1440)).toBe(300);
  });

  it("sizes the drawer as T3 Code does: 280 by default, 180 at least, three quarters of the window at most", () => {
    expect(storedDrawerHeight(undefined)).toBe(280);
    expect(storedDrawerHeight("90")).toBe(180);
    expect(drawerMaxHeight(900)).toBe(675);
    expect(drawerMaxHeight(200)).toBe(180);
    expect(shownDrawerHeight(1000, 900)).toBe(675);
  });

  it("draws the dock no wider than the chat's minimum and the rail leave room for", () => {
    // 0.7.3: a 545 px dock at 1280 with a 256 px sidebar pushed the rail 47 px past the window.
    expect(shownDockWidth(545, 1280, 256)).toBe(1280 - 256 - DOCK_RAIL_WIDTH - CHAT_MIN_WIDTH);
    expect(256 + CHAT_MIN_WIDTH + shownDockWidth(545, 1280, 256) + DOCK_RAIL_WIDTH).toBe(1280);
    // The stored width comes back when there is room.
    expect(shownDockWidth(545, 1728, 256)).toBe(545);
    expect(shownDockWidth(100, 1728, 256)).toBe(DOCK_MIN_WIDTH);
    expect(dockMaxWidth(1100, 256)).toBe(1100 - 256 - DOCK_RAIL_WIDTH - CHAT_MIN_WIDTH);
    expect(dockMaxWidth(900, 400)).toBe(DOCK_MIN_WIDTH);
  });

  it("keeps a wide sidebar from squeezing an open dock under its minimum", () => {
    expect(sidebarMaxWidth(1080)).toBe(1080 - 640);
    expect(sidebarMaxWidth(1080, DOCKED_CONTENT_MIN_WIDTH)).toBe(1080 - DOCKED_CONTENT_MIN_WIDTH);
    const sidebar = shownSidebarWidth(600, 1080, DOCKED_CONTENT_MIN_WIDTH);
    expect(sidebar + CHAT_MIN_WIDTH + DOCK_RAIL_WIDTH + shownDockWidth(560, 1080, sidebar)).toBeLessThanOrEqual(1080);
  });
});
