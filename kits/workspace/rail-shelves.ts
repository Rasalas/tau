import type { ClientStorage, UiSession } from "tau";
import type { ThreadRailSection } from "./protocol.js";

/** Which shelves this client has open or folded; the section's `collapsed` is the default. */
export const SHELVES_OPEN_KEY = "tau.workspace.rail-shelves-open.v1";
/** T3 Code's settled tail: ten rows, then 25 a page. */
export const SETTLED_FIRST_PAGE = 10;
export const SHELF_PAGE = 25;

export type ShelvesOpen = Readonly<Record<string, boolean>>;

export function readShelvesOpen(storage: ClientStorage): ShelvesOpen {
  try {
    const value: unknown = JSON.parse(storage.get(SHELVES_OPEN_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

export function writeShelvesOpen(storage: ClientStorage, open: ShelvesOpen): void {
  storage.set(SHELVES_OPEN_KEY, JSON.stringify(open));
}

export function shelfIsOpen(section: ThreadRailSection, open: ShelvesOpen): boolean {
  return !section.shelf || (open[section.id] ?? !section.collapsed);
}

export function shelfFirstPage(section: ThreadRailSection): number {
  return section.settled ? SETTLED_FIRST_PAGE : SHELF_PAGE;
}

/**
 * The rows a section draws: all of an open one up to its page, none of a folded
 * one. The thread on screen stays drawn either way, so its row never hides.
 */
export function shelfRows(section: ThreadRailSection, open: boolean, limit: number, keepId: string | undefined): UiSession[] {
  const rows = open ? section.threads.slice(0, limit) : [];
  if (!keepId || rows.some((session) => session.id === keepId)) return rows;
  const kept = section.threads.find((session) => session.id === keepId);
  return kept ? [...rows, kept] : rows;
}

/** A shelf names itself and how many it holds, open or folded ("Settled · 41", the design's). */
export function shelfHeading(section: ThreadRailSection): string {
  return `${section.label} · ${section.threads.length}`;
}
