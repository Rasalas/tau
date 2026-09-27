/**
 * The sidebar's and the dock's widths and the drawer's height, as T3 Code sizes them. Pure, so
 * the clamps are tested without a window; the caller passes the viewport.
 */
import { CHAT_MIN_WIDTH, DOCK_RAIL_WIDTH, STAGE_MIN_WIDTH } from "./center-layout";

export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 208;
/** What the sidebar always leaves the rest of the window. */
export const MAIN_CONTENT_MIN_WIDTH = 640;

/** The dock's panel, beside its icon rail; a stored width is kept within these. */
export const DOCK_MIN_WIDTH = 220;
export const DOCK_MAX_WIDTH = 560;
/** What the chat, the dock's rail and the narrowest dock panel need beside the sidebar while the dock is open. */
export const DOCKED_CONTENT_MIN_WIDTH = CHAT_MIN_WIDTH + DOCK_RAIL_WIDTH + DOCK_MIN_WIDTH;

export const DRAWER_DEFAULT_HEIGHT = 280;
export const DRAWER_MIN_HEIGHT = 180;
const DRAWER_MAX_HEIGHT_RATIO = 0.75;

/** `reserve` is what the rest of the window keeps; an open dock needs more than the default. */
export function sidebarMaxWidth(viewportWidth: number, reserve = MAIN_CONTENT_MIN_WIDTH): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth) - Math.max(MAIN_CONTENT_MIN_WIDTH, reserve));
}

/** A stored width, or the default; never below the minimum. The viewport clamps it when drawn. */
export function storedSidebarWidth(stored: string | null | undefined): number {
  const width = Number(stored);
  return stored && Number.isFinite(width) ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)) : SIDEBAR_DEFAULT_WIDTH;
}

/** The width drawn in a viewport this wide: the preference, as far as the window allows. */
export function shownSidebarWidth(preferred: number, viewportWidth: number, reserve?: number): number {
  return Math.min(Math.max(SIDEBAR_MIN_WIDTH, preferred), sidebarMaxWidth(viewportWidth, reserve));
}

/**
 * The dock panel's drawn width: the preference, as far as the chat's minimum
 * and the rail leave room beside the sidebar. A wider stored width comes back
 * when the window grows; the grid never runs past the window's edge.
 */
export function dockMaxWidth(viewportWidth: number, sidebarWidth: number): number {
  const room = Math.floor(viewportWidth) - sidebarWidth - DOCK_RAIL_WIDTH - CHAT_MIN_WIDTH;
  return Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, room));
}

export function shownDockWidth(preferred: number, viewportWidth: number, sidebarWidth: number): number {
  return Math.min(Math.max(DOCK_MIN_WIDTH, preferred), dockMaxWidth(viewportWidth, sidebarWidth));
}

export function drawerMaxHeight(viewportHeight: number): number {
  return Math.max(DRAWER_MIN_HEIGHT, Math.floor(viewportHeight * DRAWER_MAX_HEIGHT_RATIO));
}

export function storedDrawerHeight(stored: string | null | undefined): number {
  const height = Number(stored);
  return stored && Number.isFinite(height) ? Math.max(DRAWER_MIN_HEIGHT, Math.round(height)) : DRAWER_DEFAULT_HEIGHT;
}

export function shownDrawerHeight(preferred: number, viewportHeight: number): number {
  return Math.min(Math.max(DRAWER_MIN_HEIGHT, preferred), drawerMaxHeight(viewportHeight));
}

/** The chat's share of the centre until the divider is dragged, leaving the tool a bit more than half. */
const CHAT_DEFAULT_SHARE = 0.42;
/** Dragging the divider this far below the chat's minimum maximizes the tool. */
export const CHAT_MAXIMIZE_OVERDRAG = 64;

export function storedChatWidth(stored: string | null | undefined): number | undefined {
  const width = Number(stored);
  return stored && Number.isFinite(width) ? Math.max(CHAT_MIN_WIDTH, Math.round(width)) : undefined;
}

/** `chatMin`: the chat's minimum on this client (`TABLET_CHAT_MIN_WIDTH` on a tablet). */
export function chatMaxWidth(centerWidth: number, chatMin = CHAT_MIN_WIDTH): number {
  return Math.max(chatMin, Math.floor(centerWidth) - STAGE_MIN_WIDTH);
}

export function defaultChatWidth(centerWidth: number, chatMin = CHAT_MIN_WIDTH): number {
  return shownChatWidth(undefined, centerWidth, chatMin);
}

/** The chat's width in a centre this wide: the preference, or the default share, within both minimums. */
export function shownChatWidth(preferred: number | undefined, centerWidth: number, chatMin = CHAT_MIN_WIDTH): number {
  const wanted = preferred ?? Math.round(centerWidth * CHAT_DEFAULT_SHARE);
  return Math.min(chatMaxWidth(centerWidth, chatMin), Math.max(chatMin, wanted));
}
