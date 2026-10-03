import { useEffect, useRef, type RefObject } from "react";

/**
 * Pulling a bottom sheet down to close it, after the user's rules for mobile
 * sheets: the whole surface is a handle except editable fields, scrolling inside wins
 * while it can still go up. At the top, a downward pull moves the sheet
 * while the browser still permits cancelling the scroll gesture. Short moves and taps never
 * close. The thresholds are design values, not measurements; tune them on a
 * real phone.
 */
export const SHEET_DRAG_SLOP_PX = 10;
export const SHEET_CLOSE_DISTANCE_PX = 96;
export const SHEET_CLOSE_VELOCITY = 0.5;
export const SHEET_CLOSE_MIN_DISTANCE_PX = 24;

/** Whether letting go after a pull of `distance` px at `velocity` px/ms closes the sheet. */
export function sheetDragCloses(distance: number, velocity: number): boolean {
  return distance >= SHEET_CLOSE_DISTANCE_PX || (distance >= SHEET_CLOSE_MIN_DISTANCE_PX && velocity >= SHEET_CLOSE_VELOCITY);
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

/**
 * Makes `sheet` follow a finger that pulls it down, and calls `onClose` when
 * the pull is long or fast enough; otherwise the sheet springs back. Touch
 * only: a mouse closes a sheet with its button, Escape or the scrim.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = sheet.current;
    if (!element) return undefined;
    let pull: { startY: number; lastY: number; lastT: number; velocity: number; origin?: number; scroller?: HTMLElement } | undefined;
    let suppressClick = false;
    const settle = (offset: number) => {
      element.style.transition = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "none" : "transform 180ms ease";
      element.style.transform = offset === 0 ? "" : `translateY(${offset}px)`;
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (pull?.origin !== undefined) settle(0);
      pull = undefined;
      suppressClick = false;
      if (event.touches.length !== 1 || !touch || !(event.target instanceof Element) || !sheetDragMayStart(event.target)) return;
      pull = { startY: touch.clientY, lastY: touch.clientY, lastT: performance.now(), velocity: 0, scroller: scrollerOf(event.target, element) };
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1) { onCancel(); return; }
      if (!pull || !touch) return;
      const y = touch.clientY;
      const down = y > pull.lastY;
      if (pull.origin === undefined) {
        const atTop = !pull.scroller || pull.scroller.scrollTop <= 0;
        if (!(down && atTop && y - pull.startY >= SHEET_DRAG_SLOP_PX)) { pull.lastY = y; pull.lastT = performance.now(); return; }
        if (!event.cancelable) { pull = undefined; return; }
        pull.origin = y;
        suppressClick = true;
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = Math.max(1, performance.now() - pull.lastT);
      pull.velocity = (y - pull.lastY) / elapsed;
      pull.lastY = y;
      pull.lastT = performance.now();
      element.style.transition = "none";
      element.style.transform = `translateY(${Math.max(0, y - pull.origin)}px)`;
    };
    const onEnd = () => {
      const current = pull;
      pull = undefined;
      if (current?.origin === undefined) return;
      const distance = Math.max(0, current.lastY - current.origin);
      if (sheetDragCloses(distance, current.velocity)) close.current();
      else settle(0);
    };
    const onCancel = () => {
      pull = undefined;
      settle(0);
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
      element.removeEventListener("click", onClick, true);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onCancel);
    };
  }, [sheet]);
}
