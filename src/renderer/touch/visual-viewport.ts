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

/**
 * `resized` covers a web view that shrinks the whole page for the keyboard
 * (Android's): the page is shorter than the tallest it was at this width while
 * a text field has the keyboard. Without it a hardware keyboard would pass for
 * none there, and a return key would send.
 * A native iPad's floating shortcut bar only needs space below the composer;
 * `floatingToolbar` leaves the sidebar at full height until a full keyboard opens.
 */
export function viewportFit(
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | undefined,
  resized?: { tallest: number; editing: boolean },
  floatingToolbar = false,
): ViewportFit {
  const shrunk = Boolean(resized?.editing) && (resized?.tallest ?? 0) - layoutHeight >= KEYBOARD_MIN_PX;
  if (!visual) return { height: layoutHeight, top: 0, keyboard: shrunk };
  const covered = layoutHeight - visual.height - visual.offsetTop;
  const keyboard = covered >= KEYBOARD_MIN_PX || shrunk;
  if (floatingToolbar && !keyboard) return { height: layoutHeight, top: 0, keyboard };
  return { height: Math.round(visual.height), top: Math.round(visual.offsetTop), keyboard };
}

/** The tallest page seen at this width; a rotation or a narrower window starts over. */
export function tallestHeight(previous: { width: number; height: number } | undefined, width: number, height: number): { width: number; height: number } {
  return previous && previous.width === width ? { width, height: Math.max(previous.height, height) } : { width, height };
}

/** A focused element the on-screen keyboard types into. */
export function editingFocused(active: Element | null | undefined): boolean {
  if (!active) return false;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  if (active.tagName === "TEXTAREA") return true;
  return active.tagName === "INPUT" && !/^(checkbox|radio|range|button|submit|reset|color|file|image)$/iu.test((active as HTMLInputElement).type);
}
