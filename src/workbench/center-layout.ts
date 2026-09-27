/**
 * How the centre holds the chat and an open stage in a window this wide: side
 * by side, side by side once the dock yields its panel to its icon rail (where
 * the stage would otherwise be narrower than it wants), or tabs, the chat first,
 * where even the rail leaves too little room or the user maximized the stage.
 * Pure, so the decision is tested without a window; the minimums mirror styles.css.
 */

/** The chat's column: the composer's toolbar stays on one line. */
export const CHAT_MIN_WIDTH = 480;
/** The stage's column: a file's header and a few dozen columns of code. */
export const STAGE_MIN_WIDTH = 360;
export const CENTER_SPLIT_MIN_WIDTH = CHAT_MIN_WIDTH + STAGE_MIN_WIDTH;
/** A tablet's chat: its touch composer folds to an upright phone's width, so a tool fits beside it on an iPad on its side. */
export const TABLET_CHAT_MIN_WIDTH = 360;
/** The stage's reading width, about 67 columns of 12 px code: the dock folds while the stage would be narrower. */
export const STAGE_PREFERRED_WIDTH = 560;
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
  /** The chat's minimum on this client; `CHAT_MIN_WIDTH` unless a tablet says otherwise. */
  chatMin?: number;
}

export interface CenterLayout {
  /** The dock's panel gives way to its rail for this window; the stored choice stays open. */
  dockYields: boolean;
  /** Chat and stage share one column and the stage's tab strip. */
  tabs: boolean;
  /** Chat and stage would fit side by side, so maximizing is a choice to offer. */
  canSplit: boolean;
}

export function centerLayout({ windowWidth, sidebarWidth, dock, stageOpen, keepDock, maximized, chatMin = CHAT_MIN_WIDTH }: CenterLayoutInput): CenterLayout {
  if (!stageOpen) return { dockYields: false, tabs: false, canSplit: true };
  const panel = dock?.open && windowWidth > DOCK_PANEL_MIN_WINDOW ? dock.width : 0;
  const room = windowWidth - sidebarWidth - (dock ? DOCK_RAIL_WIDTH : 0) - panel;
  const splitMin = chatMin + STAGE_MIN_WIDTH;
  const fits = room >= splitMin;
  // The chat keeps its minimum first, so the stage reaches its reading width exactly here.
  const roomy = room >= chatMin + STAGE_PREFERRED_WIDTH;
  const fitsOnRail = !roomy && panel > 0 && !keepDock && room + panel >= splitMin;
  const canSplit = fits || fitsOnRail;
  return { dockYields: fitsOnRail && !maximized, tabs: maximized || !canSplit, canSplit };
}

/** Where a tool shows when it opens: a stage tab, the whole space beside the chat, the dock's list, or the drawer. */
export type ToolPlace = "tab" | "beside" | "list" | "drawer";

export interface ToolPlaceInput {
  placement?: "dock" | "drawer";
  width?: "narrow" | "wide";
  /** The panel may move onto the stage at all. */
  maximizable?: boolean;
  /** The stage holds tabs besides this tool's own, so the centre already shows a tab strip. */
  stageOpen: boolean;
  maximized: boolean;
}

/**
 * The one placement rule for tools: a wide tool joins the stage's tabs, and
 * comes to the front, whenever the centre shows tabs; with no stage it fills
 * the space beside the chat. Lists dock or float; the drawer stays the drawer.
 */
export function toolPlace({ placement, width, maximizable, stageOpen, maximized }: ToolPlaceInput): ToolPlace {
  if (placement === "drawer") return "drawer";
  if (width !== "wide") return "list";
  return maximizable && (stageOpen || maximized) ? "tab" : "beside";
}
