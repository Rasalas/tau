/**
 * What the on-screen keyboard leaves of the page. A phone's browser shrinks
 * the visual viewport, not the layout one, when the keyboard slides in; the
 * compact layout sizes itself to what is left so the composer rides on top of
 * the keyboard rather than under it.
 */
export interface ViewportFit {
  /** Height the app may use, in CSS pixels. */
  height: number;
  /** How far the visual viewport is scrolled down the layout one. */
  top: number;
  /** Whether a keyboard (or anything else) covers the bottom of the page. */
  keyboard: boolean;
}

/** Below this, a shorter visual viewport is browser chrome moving, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

export function viewportFit(layoutHeight: number, visual: { height: number; offsetTop: number } | undefined): ViewportFit {
  if (!visual) return { height: layoutHeight, top: 0, keyboard: false };
  const covered = layoutHeight - visual.height - visual.offsetTop;
  return { height: Math.round(visual.height), top: Math.round(visual.offsetTop), keyboard: covered >= KEYBOARD_MIN_PX };
}
