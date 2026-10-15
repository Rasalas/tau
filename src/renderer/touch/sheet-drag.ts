import { useLayoutEffect, useRef, type RefObject } from "react";

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
/** The half-open stop as a share of the visible window: Material's partial expansion, iOS's medium detent. */
export const SHEET_MEDIUM_SHARE = 0.5;

/** Whether letting go after a pull of `distance` px at `velocity` px/ms closes the sheet. */
export function sheetDragCloses(distance: number, velocity: number): boolean {
  return distance >= SHEET_CLOSE_DISTANCE_PX || (distance >= SHEET_CLOSE_MIN_DISTANCE_PX && velocity >= SHEET_CLOSE_VELOCITY);
}

/** How far below its full height a sheet `height` px tall rests half open in a window `viewport` px tall; 0 when it fits. */
export function sheetMediumOffset(height: number, viewport: number): number {
  return Math.max(0, Math.round(height - viewport * SHEET_MEDIUM_SHARE));
}

/** Where a pull from rest `from`, let go `offset` px below full height at `velocity` px/ms, leaves the sheet: closed, 0 or `medium`. */
export function sheetPullRest(offset: number, velocity: number, from: number, medium: number): number | "close" {
  if (sheetDragCloses(offset - medium, velocity)) return "close";
  if (medium === 0) return 0;
  if (velocity >= SHEET_CLOSE_VELOCITY && offset - from >= SHEET_CLOSE_MIN_DISTANCE_PX) return medium;
  if (velocity <= -SHEET_CLOSE_VELOCITY && from - offset >= SHEET_CLOSE_MIN_DISTANCE_PX) return 0;
  return offset < medium / 2 ? 0 : medium;
}

const CONTROLS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider'], [data-sheet-drag='off']";
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** A field the on-screen keyboard opens for. */
function opensKeyboard(element: Element): boolean {
  return element instanceof HTMLInputElement ? TEXT_INPUTS.has(element.type) : element.matches("textarea, [contenteditable=''], [contenteditable='true']");
}

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

const viewportHeight = () => window.visualViewport?.height ?? window.innerHeight;

/**
 * Makes `sheet` follow a finger that pulls it down, and calls `onClose` when
 * the pull is long or fast enough; otherwise the sheet springs back. Touch
 * only: a mouse closes a sheet with its button, Escape or the scrim.
 * With `halfOpen`, a sheet taller than half the window rests half open until a
 * pull up, the wheel or focus on a field or below the edge opens it fully.
 */
export function useSheetDrag(sheet: RefObject<HTMLElement | null>, onClose: () => void, { halfOpen = false }: { halfOpen?: boolean } = {}): void {
  const close = useRef(onClose);
  close.current = onClose;
  // Before the first paint, so a half-open sheet never shows at full height.
  useLayoutEffect(() => {
    const element = sheet.current;
    if (!element) return undefined;
    const active = document.activeElement;
    let expanded = !halfOpen || (active instanceof Element && element.contains(active) && opensKeyboard(active));
    let pull: { startY: number; lastY: number; lastT: number; velocity: number; origin?: number; from: number; scroller?: HTMLElement } | undefined;
    let suppressClick = false;
    const mediumOffset = () => halfOpen ? sheetMediumOffset(element.offsetHeight, viewportHeight()) : 0;
    const restOffset = () => expanded ? 0 : mediumOffset();
    const place = () => {
      const rest = restOffset();
      if (rest > 0) {
        element.dataset.detent = "medium";
        element.style.setProperty("--touch-sheet-offset", `${rest}px`);
      } else {
        delete element.dataset.detent;
        element.style.removeProperty("--touch-sheet-offset");
      }
    };
    const settle = () => {
      element.style.transition = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "none" : "transform 180ms ease";
      place();
      element.style.transform = "";
    };
    const expand = () => {
      if (restOffset() === 0) return;
      expanded = true;
      settle();
    };
    const refit = () => {
      if (pull?.origin !== undefined) return;
      element.style.transition = "none";
      place();
    };
    place();
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (pull?.origin !== undefined) settle();
      pull = undefined;
      suppressClick = false;
      if (event.touches.length !== 1 || !touch || !(event.target instanceof Element) || !sheetDragMayStart(event.target)) return;
      pull = { startY: touch.clientY, lastY: touch.clientY, lastT: performance.now(), velocity: 0, from: 0, scroller: scrollerOf(event.target, element) };
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1) { onCancel(); return; }
      if (!pull || !touch) return;
      const y = touch.clientY;
      if (pull.origin === undefined) {
        const from = restOffset();
        const down = y > pull.lastY && y - pull.startY >= SHEET_DRAG_SLOP_PX && (!pull.scroller || pull.scroller.scrollTop <= 0);
        // Half open, the content does not scroll (sheet.css): a pull up opens the sheet instead.
        const up = from > 0 && y < pull.lastY && pull.startY - y >= SHEET_DRAG_SLOP_PX && !pull.scroller;
        if (!down && !up) { pull.lastY = y; pull.lastT = performance.now(); return; }
        if (!event.cancelable) { pull = undefined; return; }
        pull.origin = y;
        pull.from = from;
        suppressClick = true;
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = Math.max(1, performance.now() - pull.lastT);
      pull.velocity = (y - pull.lastY) / elapsed;
      pull.lastY = y;
      pull.lastT = performance.now();
      element.style.transition = "none";
      element.style.transform = `translateY(${Math.max(0, pull.from + y - pull.origin)}px)`;
    };
    const onEnd = () => {
      const current = pull;
      pull = undefined;
      if (current?.origin === undefined) return;
      const rest = sheetPullRest(Math.max(0, current.from + current.lastY - current.origin), current.velocity, current.from, mediumOffset());
      if (rest === "close") { close.current(); return; }
      expanded = rest === 0;
      settle();
    };
    const onCancel = () => {
      pull = undefined;
      settle();
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || restOffset() === 0) return;
      event.preventDefault();
      expand();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && (opensKeyboard(target) || target.getBoundingClientRect().bottom > viewportHeight())) expand();
    };
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
    resized?.observe(element);
    window.visualViewport?.addEventListener("resize", refit);
    window.addEventListener("resize", refit);
    element.addEventListener("click", onClick, true);
    element.addEventListener("focusin", onFocus);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onCancel);
    return () => {
      resized?.disconnect();
      window.visualViewport?.removeEventListener("resize", refit);
      window.removeEventListener("resize", refit);
      element.removeEventListener("click", onClick, true);
      element.removeEventListener("focusin", onFocus);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onCancel);
    };
  }, [halfOpen, sheet]);
}
