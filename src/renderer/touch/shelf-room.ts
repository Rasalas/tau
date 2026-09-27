import { useLayoutEffect, type RefObject } from "react";

/** The share of the list the settled shelf gets when it and the active threads are both long. */
export const SHELF_SHARE = 1 / 3;

/** How tall the settled shelf may grow: a third of the list, or all the active threads leave free. */
export function shelfRoom(height: number, activeHeight: number): number {
  return Math.max(Math.round(height * SHELF_SHARE), height - activeHeight);
}

/**
 * Keeps `--shelf-room` on `container` at `shelfRoom` of its height and of the
 * height `active` needs; `content` is what grows inside `active` as rows come.
 * The same rule as the desktop rail's (`kits/workspace/rail-shelf-room.ts`).
 */
export function useShelfRoom(container: RefObject<HTMLElement | null>, active: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const box = container.current;
    const list = active.current;
    const rows = content.current;
    if (!box || !list || !rows || typeof ResizeObserver === "undefined") return undefined;
    const update = () => box.style.setProperty("--shelf-room", `${shelfRoom(box.clientHeight, list.scrollHeight)}px`);
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(rows);
    update();
    return () => observer.disconnect();
  });
}
