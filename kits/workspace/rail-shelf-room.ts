import { useLayoutEffect, type RefObject } from "react";

/** The share of the rail the shelves under the active threads get when both are long. */
export const SHELF_SHARE = 1 / 3;

/**
 * How tall the shelves under the active threads may grow: a third of the
 * rail, or everything the active threads leave free when they are few.
 */
export function shelfRoom(height: number, activeHeight: number): number {
  return Math.max(Math.round(height * SHELF_SHARE), height - activeHeight);
}

/**
 * Keeps `--shelf-room` on `container` at `shelfRoom` of its height and of what
 * the active list (`active`, whose child `content` grows with its rows) needs.
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
  }, [active, container, content]);
}
