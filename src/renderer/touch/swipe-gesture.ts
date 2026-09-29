/**
 * The arithmetic of a row's swipe in the thread list: actions sit
 * behind the trailing edge, a short swipe opens the tray, a long one runs the
 * first action. Offsets are negative, in pixels, leftwards from rest.
 */

/** One action's column in the tray. */
export const SWIPE_ACTION_WIDTH = 58;
/** Movement before the gesture picks an axis; vertical first means a scroll. */
export const SWIPE_SLOP_PX = 10;
/** How long a press rests before it counts as a long press. */
export const LONG_PRESS_MS = 500;

export function swipeTrayWidth(actions: number): number {
  return actions * SWIPE_ACTION_WIDTH;
}

/** How far a full swipe goes before it runs the primary action. */
export function swipeCommitDistance(trayWidth: number, rowWidth: number): number {
  return Math.max(trayWidth + 44, rowWidth * 0.58);
}

export type SwipeAxis = "pending" | "horizontal" | "vertical";

export function swipeAxis(dx: number, dy: number): SwipeAxis {
  if (Math.abs(dy) >= SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) return "vertical";
  if (Math.abs(dx) >= SWIPE_SLOP_PX) return "horizontal";
  return "pending";
}

/** Where the row sits while a finger drags it: never right of rest, never past the row. */
export function swipeOffset(start: number, dx: number, rowWidth: number): number {
  return Math.min(0, Math.max(-rowWidth, start + dx));
}

export type SwipeRelease = "close" | "open" | "commit";

/** What letting go does: past the commit line runs the primary action, past 42 % of the tray opens it. */
export function swipeRelease(offset: number, trayWidth: number, rowWidth: number): SwipeRelease {
  const distance = -offset;
  if (trayWidth === 0) return "close";
  if (distance >= swipeCommitDistance(trayWidth, rowWidth)) return "commit";
  return distance >= trayWidth * 0.42 ? "open" : "close";
}
