/**
 * How the centre holds the conversation and the stage in a window this wide:
 * side by side, or one of them folded to its spine — the stage when the user
 * folds it or it holds nothing, the conversation when the stage is maximized
 * or the window is too narrow for both. Pure, so the decision is tested
 * without a window; the minimums mirror styles.css.
 */

/** The chat's column: the composer's toolbar stays on one line. */
export const CHAT_MIN_WIDTH = 480;
/** The stage's column: a file's header and a few dozen columns of code. */
export const STAGE_MIN_WIDTH = 360;
export const CENTER_SPLIT_MIN_WIDTH = CHAT_MIN_WIDTH + STAGE_MIN_WIDTH;
/** A tablet's chat: its touch composer folds to an upright phone's width, so a tool fits beside it on an iPad on its side. */
export const TABLET_CHAT_MIN_WIDTH = 360;
/** The stage's share of the window until the divider is dragged: about half, as in the workbench design. */
export const STAGE_DEFAULT_SHARE = 0.5;

export interface CenterLayoutInput {
  windowWidth: number;
  /** The sidebar's drawn width; 0 while it is hidden. */
  sidebarWidth: number;
  /** The stage holds tabs. */
  stageOpen: boolean;
  /** The user folded the stage to its spine. */
  folded?: boolean;
  /** The user asked for the stage over the whole centre. */
  maximized: boolean;
  /** The chat's minimum on this client; `CHAT_MIN_WIDTH` unless a tablet says otherwise. */
  chatMin?: number;
}

export interface CenterLayout {
  /** The stage shows its tabs; otherwise it is its spine, or nothing. */
  stageShown: boolean;
  /** Only one of the two fits, or the stage is maximized: the other is folded to its spine. */
  tabs: boolean;
  /** Chat and stage would fit side by side, so maximizing is a choice to offer. */
  canSplit: boolean;
}

export function centerLayout({ windowWidth, sidebarWidth, stageOpen, folded = false, maximized, chatMin = CHAT_MIN_WIDTH }: CenterLayoutInput): CenterLayout {
  const room = windowWidth - sidebarWidth;
  const canSplit = room >= chatMin + STAGE_MIN_WIDTH;
  const stageShown = stageOpen && !folded;
  return { stageShown, tabs: stageShown && (maximized || !canSplit), canSplit };
}

/** Where a tool shows when it opens: a stage tab, or the drawer below both. */
export type ToolPlace = "tab" | "drawer";

export interface ToolPlaceInput {
  placement?: "dock" | "drawer";
}

/**
 * The one placement rule for tools: every panel opens as a tab of the stage
 * and comes to the front; only a panel that asked for the drawer stays there.
 */
export function toolPlace({ placement }: ToolPlaceInput): ToolPlace {
  return placement === "drawer" ? "drawer" : "tab";
}
