import { useLayoutEffect, type RefObject } from "react";

/**
 * A rectangle of the window the host paints a native view over — today the
 * preview browser's `WebContentsView` ([ADR 0012](../../docs/adr/0012-preview-browser.md)).
 * That view is a sibling of the document, not a layer in it, so no z-index puts
 * a float in front of it. Surfaces that must not be swallowed step aside instead.
 *
 * Nothing is reserved unless a native view is actually on screen, so a menu
 * behaves exactly as before whenever the preview is closed or hidden.
 */
export interface ReservedRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Breathing room between a float and the region it is kept out of. */
const GAP = 8;

let region: ReservedRegion | undefined;
const listeners = new Set<() => void>();

function same(left: ReservedRegion | undefined, right: ReservedRegion | undefined): boolean {
  if (!left || !right) return left === right;
  return left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom;
}

export function reserveRegion(next: ReservedRegion | undefined): void {
  if (same(region, next)) return;
  region = next;
  listeners.forEach((listener) => listener());
}

export function reservedRegion(): ReservedRegion | undefined {
  return region;
}

export function subscribeReservedRegion(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * How far left an element has to slide to clear the reserved region: 0 when it
 * already misses it, and 0 again when sliding would only push it off the other
 * edge — half a menu beats no menu.
 */
export function keepClearShift(element: ReservedRegion, area: ReservedRegion | undefined): number {
  if (!area) return 0;
  if (element.right <= area.left || element.left >= area.right) return 0;
  if (element.bottom <= area.top || element.top >= area.bottom) return 0;
  const needed = element.right - area.left + GAP;
  return needed <= element.left - GAP ? needed : 0;
}

/**
 * Slides a floating element left, through `--keep-clear-x`, until it no longer
 * lands on the reserved region. Applied to the element rather than its anchor
 * so the anchor's own layout — a title bar button, a composer chip — is untouched.
 */
export function useKeepClear(ref: RefObject<HTMLElement | null>, active = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return undefined;
    const apply = (): void => {
      // Measure unshifted, or each pass would correct the previous one again.
      element.style.setProperty("--keep-clear-x", "0px");
      element.classList.add("keeps-clear");
      const shift = keepClearShift(element.getBoundingClientRect(), reservedRegion());
      if (shift > 0) element.style.setProperty("--keep-clear-x", `${-shift}px`);
    };
    apply();
    const stop = subscribeReservedRegion(apply);
    window.addEventListener("resize", apply);
    return () => {
      stop();
      window.removeEventListener("resize", apply);
      element.classList.remove("keeps-clear");
      element.style.removeProperty("--keep-clear-x");
    };
  }, [active, ref]);
}

/**
 * Publishes the workbench's centre column as `--stage-left` / `--stage-right`,
 * the band a fixed float may centre itself on. The window's own centre is the
 * wrong anchor: it drifts into the dock, which is exactly the reserved side.
 */
export function publishStageBand(element: Element, root: HTMLElement = document.documentElement): () => void {
  const style = root.style;
  const publish = (): void => {
    const rect = element.getBoundingClientRect();
    style.setProperty("--stage-left", `${Math.round(rect.left)}px`);
    style.setProperty("--stage-right", `${Math.round(window.innerWidth - rect.right)}px`);
  };
  publish();
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
  observer?.observe(element);
  window.addEventListener("resize", publish);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", publish);
    style.removeProperty("--stage-left");
    style.removeProperty("--stage-right");
  };
}
