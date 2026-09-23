/**
 * The sidebar's width and the drawer's height, as T3 Code sizes them. Pure, so
 * the clamps are tested without a window; the caller passes the viewport.
 */
export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 208;
/** What the sidebar always leaves the rest of the window. */
export const MAIN_CONTENT_MIN_WIDTH = 640;

export const DRAWER_DEFAULT_HEIGHT = 280;
export const DRAWER_MIN_HEIGHT = 180;
const DRAWER_MAX_HEIGHT_RATIO = 0.75;

export function sidebarMaxWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH);
}

/** A stored width, or the default; never below the minimum. The viewport clamps it when drawn. */
export function storedSidebarWidth(stored: string | null | undefined): number {
  const width = Number(stored);
  return stored && Number.isFinite(width) ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)) : SIDEBAR_DEFAULT_WIDTH;
}

/** The width drawn in a viewport this wide: the preference, as far as the window allows. */
export function shownSidebarWidth(preferred: number, viewportWidth: number): number {
  return Math.min(Math.max(SIDEBAR_MIN_WIDTH, preferred), sidebarMaxWidth(viewportWidth));
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
