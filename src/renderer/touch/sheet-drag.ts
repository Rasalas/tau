import { useEffect, useRef, type RefObject } from "react";

/**
 * Pulling a bottom sheet, after the user's rules for mobile sheets: the whole
 * surface is a handle except editable fields, scrolling inside wins while it can
 * still go up. At the top, a downward pull moves the sheet while the browser
 * still permits cancelling the scroll gesture. Short moves and taps never
 * close. The thresholds are design values, not measurements; tune them on a
 * real phone.
 *
 * A sheet whose CSS caps it at a medium height (sheet.css) has two detents, as
 * on iOS and Android: it opens at medium, a pull up makes it large, a pull down
 * from large goes back to medium. `data-sheet-expanded` on the surface marks
 * the large one; sheet.css also lifts the cap while a text field has focus.
 */
export const SHEET_DRAG_SLOP_PX = 10;
export const SHEET_CLOSE_DISTANCE_PX = 96;
export const SHEET_CLOSE_VELOCITY = 0.5;
export const SHEET_CLOSE_MIN_DISTANCE_PX = 24;

/** Whether letting go after a pull of `distance` px at `velocity` px/ms takes the sheet on to its next detent, or closes it. */
export function sheetDragCloses(distance: number, velocity: number): boolean {
  return distance >= SHEET_CLOSE_DISTANCE_PX || (distance >= SHEET_CLOSE_MIN_DISTANCE_PX && velocity >= SHEET_CLOSE_VELOCITY);
}

/**
 * Where a pull lets go of the sheet, as offsets below its full height: it
 * started resting at `base`, medium rests at `collapse` (0 when the content
 * fits medium), full at 0; `velocity` is px/ms, down positive. Returns the
 * offset it comes to rest at, or undefined to close. Between the two detents
 * the nearer wins unless the pull was long or fast.
 */
export function sheetDragRest(base: number, offset: number, velocity: number, collapse: number): number | undefined {
  if (offset > collapse) return sheetDragCloses(offset - collapse, velocity) ? undefined : collapse;
  const other = base ? 0 : collapse;
  return sheetDragCloses(Math.abs(offset - base), Math.sign(other - base) * velocity) || Math.abs(offset - other) < Math.abs(offset - base) ? other : base;
}

const CONTROLS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider'], [data-sheet-drag='off']";

/** A pull that starts in an editable field, or while text is selected, stays there. */
export function sheetDragMayStart(target: Element, selection = typeof window === "undefined" ? null : window.getSelection()): boolean {
  if (target.closest(CONTROLS)) return false;
  return !selection || selection.isCollapsed;
}

/** The element whose scroll a pull inside the sheet would move first. */
function scrollerOf(target: Element, sheet: HTMLElement): HTMLElement | undefined {
  for (let node: Element | null = target; node && node !== sheet.parentElement; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return undefined;
}

const SETTLE_MS = 180;

/**
 * Makes `sheet` follow a finger that pulls it, moves it between its detents,
 * and calls `onClose` when a pull down is long or fast enough; otherwise the
 * sheet springs back. Touch only: a mouse closes a sheet with its button,
 * Escape or the scrim, and scrolls a medium one.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = sheet.current;
    if (!element) return undefined;
    let pull: { startX: number; startY: number; lastY: number; lastT: number; velocity: number; atTop: boolean; expanded: boolean; base: number; collapse?: number; origin?: number } | undefined;
    let suppressClick = false;
    let rest: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expand = (on: boolean) => element.toggleAttribute("data-sheet-expanded", on);
    const translate = (offset: number) => { element.style.transform = offset > 0 ? `translateY(${offset}px)` : ""; };
    // How far medium sits below full height, measured by laying the sheet out at both.
    const measureCollapse = () => {
      const expanded = element.hasAttribute("data-sheet-expanded");
      expand(true);
      const full = element.offsetHeight;
      expand(false);
      const medium = element.offsetHeight;
      expand(expanded);
      return Math.max(0, full - medium);
    };
    const finish = () => {
      clearTimeout(timer);
      rest?.();
      rest = undefined;
    };
    // Laid out full while it moves; a sheet that comes to rest at medium takes its medium layout again.
    const settle = (offset: number, collapse: number) => {
      finish();
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      element.style.transition = reduced ? "none" : `transform ${SETTLE_MS}ms ease`;
      translate(offset);
      rest = () => { element.style.transition = "none"; translate(0); expand(!offset && collapse > 0); };
      timer = setTimeout(finish, reduced ? 0 : SETTLE_MS);
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (pull?.origin !== undefined) settle(pull.base, pull.collapse ?? 0);
      finish();
      pull = undefined;
      suppressClick = false;
      if (event.touches.length !== 1 || !touch || !(event.target instanceof Element) || !sheetDragMayStart(event.target)) return;
      const scroller = scrollerOf(event.target, element);
      pull = { startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, lastT: performance.now(), velocity: 0, atTop: !scroller || scroller.scrollTop <= 0, expanded: element.hasAttribute("data-sheet-expanded"), base: 0 };
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1) { onCancel(); return; }
      if (!pull || !touch) return;
      const y = touch.clientY;
      if (pull.origin === undefined) {
        const travel = y - pull.startY;
        const pulls = pull.atTop && !(Math.abs(touch.clientX - pull.startX) > Math.abs(travel));
        // A medium sheet grows before its content scrolls; its upward moves are held from the first one.
        const grows = pulls && travel < 0 && !pull.expanded && (pull.collapse ??= measureCollapse()) > 0;
        if (grows && event.cancelable) event.preventDefault();
        if (!pulls || !(travel >= SHEET_DRAG_SLOP_PX || (grows && travel <= -SHEET_DRAG_SLOP_PX))) { pull.lastY = y; pull.lastT = performance.now(); return; }
        if (!event.cancelable) { pull = undefined; return; }
        pull.collapse ??= measureCollapse();
        pull.base = pull.expanded ? 0 : pull.collapse;
        if (pull.collapse) expand(true);
        pull.origin = y;
        suppressClick = true;
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = Math.max(1, performance.now() - pull.lastT);
      pull.velocity = (y - pull.lastY) / elapsed;
      pull.lastY = y;
      pull.lastT = performance.now();
      element.style.transition = "none";
      translate(Math.max(0, pull.base + y - pull.origin));
    };
    const onEnd = () => {
      const current = pull;
      pull = undefined;
      if (current?.origin === undefined) return;
      const collapse = current.collapse ?? 0;
      const offset = sheetDragRest(current.base, Math.max(0, current.base + current.lastY - current.origin), current.velocity, collapse);
      if (offset === undefined) close.current();
      else settle(offset, collapse);
    };
    const onCancel = () => {
      const current = pull;
      pull = undefined;
      if (current?.origin !== undefined) settle(current.base, current.collapse ?? 0);
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("click", onClick, true);
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onCancel);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("click", onClick, true);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onCancel);
    };
  }, [sheet]);
}
