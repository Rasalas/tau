import { useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";
import type { ClientStorage } from "tau";

export interface RailNavigationRow {
  id: string;
  kind: "heading" | "thread" | "draft" | "more";
  parentId?: string;
  expanded?: boolean;
  virtualIndex?: number;
}

export const GROUPS_OPEN_KEY = "tau.workspace.rail-groups-open.v1";
export type RailGroupsOpen = Readonly<Record<string, boolean>>;

export function readRailGroupsOpen(storage: ClientStorage): RailGroupsOpen {
  try {
    const value: unknown = JSON.parse(storage.get(GROUPS_OPEN_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : {};
  } catch { return {}; }
}

/** Keep an identity through reordering; disappearing children return to a surviving parent or neighbour. */
export function reconcileRailCursor(rows: readonly RailNavigationRow[], previous: readonly RailNavigationRow[], id: string | undefined, initialId?: string): string | undefined {
  const available = new Set(rows.map((row) => row.id));
  if (id && available.has(id)) return id;
  let parent = previous.find((row) => row.id === id)?.parentId;
  while (parent) {
    if (available.has(parent)) return parent;
    parent = previous.find((row) => row.id === parent)?.parentId;
  }
  const index = previous.findIndex((row) => row.id === id);
  if (index >= 0) {
    const neighbour = [...previous.slice(index + 1), ...previous.slice(0, index).reverse()].find((row) => available.has(row.id));
    if (neighbour) return neighbour.id;
  }
  return initialId && available.has(initialId) ? initialId : rows[0]?.id;
}

/** Headings and pagination are real cursor positions, including ones the virtualizer has not mounted. */
export function railKeyDestination(rows: readonly RailNavigationRow[], id: string | undefined, key: string): string | undefined {
  const index = rows.findIndex((row) => row.id === id);
  const row = rows[index];
  if (!row) return undefined;
  if (key === "Home") return rows[0]?.id;
  if (key === "End") return rows.at(-1)?.id;
  if (key === "ArrowDown" || key === "ArrowUp") return rows[(index + (key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.id;
  if (key === "ArrowLeft") return row.kind === "heading" && row.expanded ? undefined : row.parentId;
  if (key === "ArrowRight" && row.kind === "heading" && row.expanded) return rows.find((child) => child.parentId === id)?.id;
  return undefined;
}

export const railNavigationId = (target: EventTarget | null): string | undefined =>
  target instanceof Element ? target.closest<HTMLElement>("[data-navigation-row]")?.dataset.navigationRow : undefined;

/** The model owns the cursor. DOM refs only deliver focus once its target actually mounts. */
export function useRailNavigation(rows: readonly RailNavigationRow[], root: RefObject<HTMLElement | null>, initialId: string | undefined, scrollToRow: (row: RailNavigationRow, element: HTMLElement | undefined) => void) {
  const [heldId, setHeldId] = useState<string>();
  const previous = useRef<readonly RailNavigationRow[]>([]);
  const cursorId = reconcileRailCursor(rows, previous.current, heldId, initialId);
  const elements = useRef(new Map<string, HTMLElement>());
  const pending = useRef<{ id: string; scroll: boolean; activate?: boolean }>(undefined);
  const owned = useRef(false);
  const focused = useRef<HTMLElement | null>(null);
  const [cursorMounted, setCursorMounted] = useState(false);
  const [, wake] = useState(0);
  const targetOf = (id: string | undefined) => {
    const element = id ? elements.current.get(id) : undefined;
    return element?.matches("button") ? element : element?.querySelector<HTMLElement>(".thread-main, [data-navigation-target]");
  };
  useLayoutEffect(() => {
    const changed = heldId !== cursorId;
    if (changed) setHeldId(cursorId);
    previous.current = rows;
    const target = targetOf(cursorId);
    setCursorMounted(Boolean(target));
    const active = document.activeElement;
    const lost = owned.current && focused.current && !focused.current.isConnected && active === document.body;
    if (!cursorId && lost) { pending.current = undefined; root.current?.focus({ preventScroll: true }); return; }
    if (owned.current && changed && cursorId) pending.current = { id: cursorId, scroll: true };
    // Manual scrolling can unmount the focused row. Keep a proxy stop until it mounts again,
    // without scrolling the user's viewport back to it.
    if (lost && cursorId && !pending.current) pending.current = { id: cursorId, scroll: false };
    if (!pending.current) return;
    if (!owned.current || (active !== document.body && !root.current?.contains(active))) { pending.current = undefined; return; }
    if (!cursorId || pending.current.id !== cursorId) { pending.current = undefined; return; }
    const row = rows.find((entry) => entry.id === cursorId)!;
    if (pending.current.scroll) { pending.current.scroll = false; scrollToRow(row, elements.current.get(row.id)); }
    if (target) {
      const activate = pending.current.activate;
      pending.current = undefined;
      target.focus({ preventScroll: true });
      if (activate) target.click();
    } else root.current?.focus({ preventScroll: true });
  });

  const focus = (id: string, activate = false) => {
    owned.current = true;
    pending.current = { id, scroll: true, activate };
    setHeldId(id);
    wake((version) => version + 1);
  };
  return {
    cursorId,
    cursorMounted,
    focus,
    bind: (id: string) => (element: HTMLElement | null) => {
      if (element) elements.current.set(id, element); else elements.current.delete(id);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.target)) return;
      owned.current = true;
      focused.current = event.target;
      const id = railNavigationId(event.target);
      if (id) { pending.current = undefined; setHeldId(id); }
      else if (event.target === event.currentTarget && cursorId && !targetOf(cursorId) && !pending.current) focus(cursorId);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
        owned.current = false;
        pending.current = undefined;
      }
    },
  };
}
