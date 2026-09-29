import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * How the thread header's actions give way when the header runs out of room.
 * Labels go before functions leave the header, and the least used leave first:
 *
 * 1. The project actions drop their label (Add action, the first action's name).
 * 2. The project actions move into the overflow menu: set up once, run rarely.
 * 3. The Git action drops its label: it is the one whose label says what the
 *    next click does (Commit, Push, Pull, Up to date).
 * 4. "N files changed ›" shortens to "N files", as design 1l draws it in a
 *    380 px chat.
 *
 * "Open in" is no longer here: it sits in the stage's tab strip and the thread's menu.
 */
export type TitleItemShape = "label" | "icon" | "overflow";

export interface TitleCollapse {
  actions: TitleItemShape;
  git: Exclude<TitleItemShape, "overflow">;
  changes: "label" | "short";
}

export const TITLE_COLLAPSE_STEPS: readonly TitleCollapse[] = [
  { actions: "label", git: "label", changes: "label" },
  { actions: "icon", git: "label", changes: "label" },
  { actions: "overflow", git: "label", changes: "label" },
  { actions: "overflow", git: "icon", changes: "label" },
  { actions: "overflow", git: "icon", changes: "short" },
];

export const MAX_TITLE_COLLAPSE = TITLE_COLLAPSE_STEPS.length - 1;

export function titleCollapse(level: number): TitleCollapse {
  return TITLE_COLLAPSE_STEPS[Math.max(0, Math.min(MAX_TITLE_COLLAPSE, Math.floor(level)))]!;
}

/** Width the children of `row` take side by side, gaps included. */
export function rowContentWidth(row: HTMLElement): number {
  const children = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetParent !== null);
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  return children.reduce((sum, child) => sum + child.offsetWidth, 0) + gap * Math.max(0, children.length - 1);
}

/**
 * The collapse level for `row`: after any change of the room around it, back
 * to full labels, then one step at a time until its children fit. Every step
 * is measured in a layout effect, so no intermediate state is painted.
 */
export function useTitleCollapse(row: RefObject<HTMLElement | null>): number {
  const [level, setLevel] = useState(0);
  const [room, setRoom] = useState(0);

  useLayoutEffect(() => {
    const element = row.current;
    const around = element?.parentElement;
    if (!element || !around || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setRoom(Math.round(around.clientWidth)));
    observer.observe(around);
    return () => observer.disconnect();
  }, [row]);

  useLayoutEffect(() => { setLevel(0); }, [room]);

  useLayoutEffect(() => {
    const element = row.current;
    if (!element || level >= MAX_TITLE_COLLAPSE) return;
    if (rowContentWidth(element) > element.clientWidth + 1) setLevel(level + 1);
  });

  return level;
}
