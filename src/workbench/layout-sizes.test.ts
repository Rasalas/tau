import { describe, expect, it } from "vitest";
import {
  defaultChatWidth, drawerMaxHeight, shownChatWidth, shownDrawerHeight, shownSidebarWidth, sidebarMaxWidth, storedDrawerHeight, storedSidebarWidth,
} from "./layout-sizes";
import { CHAT_MIN_WIDTH, STAGE_MIN_WIDTH } from "./center-layout";

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

  it("gives the stage about half the window until the divider is dragged, within both minimums", () => {
    // 1540 wide with the sidebar: the chat takes what the stage's 770 leave.
    expect(defaultChatWidth(1284, CHAT_MIN_WIDTH, 1540)).toBe(514);
    // Narrower: the chat keeps its minimum and the stage takes the rest.
    expect(defaultChatWidth(1024, CHAT_MIN_WIDTH, 1280)).toBe(CHAT_MIN_WIDTH);
    // Wider: never more than leaves the stage its minimum.
    expect(shownChatWidth(2000, 1284, CHAT_MIN_WIDTH, 1540)).toBe(1284 - STAGE_MIN_WIDTH);
    expect(shownChatWidth(600, 1284, CHAT_MIN_WIDTH, 1540)).toBe(600);
  });
});
