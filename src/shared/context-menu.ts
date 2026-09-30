/**
 * A menu the client's OS draws at a point of the window — Electron's
 * `Menu.popup` — as plain data, since it crosses to the window's process.
 */
export type NativeMenuEntry =
  | {
    type: "item";
    id: string;
    label: string;
    enabled?: boolean;
    checked?: boolean;
    submenu?: NativeMenuEntry[];
    /** A pill after the label, e.g. "Default"; a native menu writes it in parentheses. */
    badge?: string | undefined;
    /** A lucide icon by its component name (`Trash2`); a client without it shows none. */
    icon?: string | undefined;
    /** What the page shows at the item's end: a chord (`⌘⇧S`) or a short note. */
    hint?: string | undefined;
  }
  | { type: "separator" }
  | { type: "heading"; label: string };

export interface MenuPoint {
  x: number;
  y: number;
}

const MAX_ENTRIES = 200;
const MAX_DEPTH = 4;
const MAX_LABEL = 200;
const ICON_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const MAX_HINT = 60;

function label(method: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL) throw new Error(`${method}: a menu label must be a string of 1 to ${MAX_LABEL} characters`);
  return value;
}

function entries(method: string, value: unknown, depth: number): NativeMenuEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error(`${method}: menu must be a list of at most ${MAX_ENTRIES} entries`);
  if (depth > MAX_DEPTH) throw new Error(`${method}: menu nests deeper than ${MAX_DEPTH}`);
  return value.map((raw): NativeMenuEntry => {
    if (!raw || typeof raw !== "object") throw new Error(`${method}: menu entry must be an object`);
    const entry = raw as Record<string, unknown>;
    if (entry.type === "separator") return { type: "separator" };
    if (entry.type === "heading") return { type: "heading", label: label(method, entry.label) };
    if (entry.type !== "item") throw new Error(`${method}: unknown menu entry type`);
    if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error(`${method}: a menu item needs an id`);
    return {
      type: "item",
      id: entry.id,
      label: label(method, entry.label),
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(entry.checked === true ? { checked: true } : {}),
      ...(typeof entry.badge === "string" && entry.badge.length > 0 && entry.badge.length <= MAX_LABEL ? { badge: entry.badge } : {}),
      ...(typeof entry.icon === "string" && ICON_NAME.test(entry.icon) ? { icon: entry.icon } : {}),
      ...(typeof entry.hint === "string" && entry.hint.length <= MAX_HINT ? { hint: entry.hint } : {}),
      ...(entry.submenu === undefined ? {} : { submenu: entries(method, entry.submenu, depth + 1) }),
    };
  });
}

export function decodeNativeMenu(method: string, value: unknown): NativeMenuEntry[] {
  return entries(method, value, 0);
}

export function decodeMenuPoint(method: string, value: unknown): MenuPoint {
  const point = value as Partial<MenuPoint> | undefined;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`${method}: point must have finite x and y`);
  return { x: point.x!, y: point.y! };
}
