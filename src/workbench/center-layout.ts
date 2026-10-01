/**
 * How the centre holds the conversation and the stage in a window this wide:
 * side by side, or one of them alone — the conversation when the user hides
 * the stage or it holds nothing, the stage when it is maximized, and the one
 * in front where the window is too narrow for both. Pure, so the decision is
 * tested without a window; the minimums mirror styles.css.
 */

/**
 * The chat's column beside the stage: the design's 470 px (1a) until its divider is dragged, and never
 * under 360 px, where the thread header, the composer's footer and a question card still fit on one
 * line each. A tablet's chat has the same bounds.
 */
export const CHAT_DEFAULT_WIDTH = 470;
export const CHAT_MIN_WIDTH = 360;
/** The stage's column: a file's header and a few dozen columns of code. */
export const STAGE_MIN_WIDTH = 360;
export const CENTER_SPLIT_MIN_WIDTH = CHAT_MIN_WIDTH + STAGE_MIN_WIDTH;

export interface CenterLayoutInput {
  windowWidth: number;
  /** The sidebar's drawn width; 0 while it is hidden. */
  sidebarWidth: number;
  /** The stage holds tabs. */
  stageOpen: boolean;
  /** The user hid the stage. */
  folded?: boolean;
  /** The user asked for the stage over the whole centre. */
  maximized: boolean;
}

export interface CenterLayout {
  /** The stage shows its tabs; otherwise it is hidden. */
  stageShown: boolean;
  /** Only one of the two fits, or the stage is maximized: the other is out of sight. */
  tabs: boolean;
  /** Chat and stage would fit side by side, so maximizing is a choice to offer. */
  canSplit: boolean;
}

export function centerLayout({ windowWidth, sidebarWidth, stageOpen, folded = false, maximized }: CenterLayoutInput): CenterLayout {
  const canSplit = windowWidth - sidebarWidth >= CENTER_SPLIT_MIN_WIDTH;
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
