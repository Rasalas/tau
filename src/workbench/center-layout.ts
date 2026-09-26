/**
 * How the centre holds the chat and an open stage in a window this wide: side
 * by side, side by side once the dock yields its panel to its icon rail, or
 * tabs, the chat first, where even that does not fit or the user maximized the
 * stage. Pure, so the decision is tested without a window; the numbers mirror styles.css.
 */

/** The chat's column: the composer's toolbar stays on one line. */
export const CHAT_MIN_WIDTH = 480;
/** The stage's column: a file's header and a few dozen columns of code. */
export const STAGE_MIN_WIDTH = 360;
export const CENTER_SPLIT_MIN_WIDTH = CHAT_MIN_WIDTH + STAGE_MIN_WIDTH;
/** The dock's icon rail, which stays when its panel is closed. */
export const DOCK_RAIL_WIDTH = 46;
/** Below this the stylesheet shows only the dock's rail, open or not. */
export const DOCK_PANEL_MIN_WINDOW = 1040;

export interface CenterLayoutInput {
  windowWidth: number;
  /** The sidebar's drawn width; 0 while it is hidden. */
  sidebarWidth: number;
  /** Absent when no panel is registered: then there is no rail either. */
  dock?: { open: boolean; width: number };
  stageOpen: boolean;
  /** The user opened the dock or picked a panel while the stage was open: leave the dock as it is. */
  keepDock: boolean;
  /** The user asked for the stage over the whole centre. */
  maximized: boolean;
}

export interface CenterLayout {
  /** The dock's panel gives way to its rail for this window; the stored choice stays open. */
  dockYields: boolean;
  /** Chat and stage share one column and the stage's tab strip. */
  tabs: boolean;
  /** Chat and stage would fit side by side, so maximizing is a choice to offer. */
  canSplit: boolean;
}

export function centerLayout({ windowWidth, sidebarWidth, dock, stageOpen, keepDock, maximized }: CenterLayoutInput): CenterLayout {
  if (!stageOpen) return { dockYields: false, tabs: false, canSplit: true };
  const panel = dock?.open && windowWidth > DOCK_PANEL_MIN_WINDOW ? dock.width : 0;
  const room = windowWidth - sidebarWidth - (dock ? DOCK_RAIL_WIDTH : 0) - panel;
  const fits = room >= CENTER_SPLIT_MIN_WIDTH;
  const fitsOnRail = !fits && panel > 0 && !keepDock && room + panel >= CENTER_SPLIT_MIN_WIDTH;
  const canSplit = fits || fitsOnRail;
  return { dockYields: fitsOnRail && !maximized, tabs: maximized || !canSplit, canSplit };
}
