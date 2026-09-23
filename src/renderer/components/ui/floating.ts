export type FloatingSide = "top" | "bottom" | "left" | "right";
export type FloatingAlign = "start" | "center" | "end";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FloatingOptions {
  side?: FloatingSide;
  align?: FloatingAlign;
  /** Gap between the anchor and the float. */
  offset?: number;
  /** Closest the float may come to the viewport's edge. */
  padding?: number;
}

export interface FloatingPlacement {
  left: number;
  top: number;
  side: FloatingSide;
}

const OPPOSITE: Record<FloatingSide, FloatingSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function room(side: FloatingSide, anchor: Rect, viewport: { width: number; height: number }): number {
  if (side === "top") return anchor.top;
  if (side === "bottom") return viewport.height - (anchor.top + anchor.height);
  if (side === "left") return anchor.left;
  return viewport.width - (anchor.left + anchor.width);
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

/**
 * Where a float of `size` goes beside `anchor`: on the preferred side when it
 * fits, else the opposite side when that has more room, then shifted along the
 * edge so it stays inside the viewport.
 */
export function placeFloating(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: FloatingOptions = {},
): FloatingPlacement {
  const { align = "center", offset = 6, padding = 8 } = options;
  let side = options.side ?? "bottom";
  const vertical = side === "top" || side === "bottom";
  const needed = (vertical ? size.height : size.width) + offset + padding;
  if (room(side, anchor, viewport) < needed && room(OPPOSITE[side], anchor, viewport) > room(side, anchor, viewport)) {
    side = OPPOSITE[side];
  }

  const along = (start: number, length: number, extent: number) =>
    align === "start" ? start : align === "end" ? start + length - extent : start + (length - extent) / 2;

  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    top = side === "top" ? anchor.top - offset - size.height : anchor.top + anchor.height + offset;
    left = along(anchor.left, anchor.width, size.width);
  } else {
    left = side === "left" ? anchor.left - offset - size.width : anchor.left + anchor.width + offset;
    top = along(anchor.top, anchor.height, size.height);
  }
  return {
    side,
    left: Math.round(clamp(left, padding, viewport.width - padding - size.width)),
    top: Math.round(clamp(top, padding, viewport.height - padding - size.height)),
  };
}

/** A point, such as a right-click, as a zero-sized anchor. */
export const pointRect = (x: number, y: number): Rect => ({ left: x, top: y, width: 0, height: 0 });

export const viewportSize = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });
