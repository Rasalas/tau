/**
 * The keys a phone's keyboard lacks, as the compact terminal's key bar sends
 * them. Ctrl and Alt apply once: armed by a tap, spent by the next key, from
 * the bar or from the on-screen keyboard.
 */

export type TouchModifier = "ctrl" | "alt";
export type ArrowKey = "up" | "down" | "right" | "left";

export type TouchKey =
  | { kind: "send"; id: string; label: string; title: string; data: string }
  | { kind: "arrow"; id: string; label: string; title: string; arrow: ArrowKey }
  | { kind: "modifier"; id: string; label: string; title: string; modifier: TouchModifier }
  | { kind: "paste"; id: string; label: string; title: string };

/** Left to right, after T3 Code's accessory bar; Ctrl-C and the keyboard toggle sit outside the scroller. */
export const TOUCH_KEYS: readonly TouchKey[] = [
  { kind: "send", id: "esc", label: "esc", title: "Escape", data: "\u001b" },
  { kind: "modifier", id: "ctrl", label: "ctrl", title: "Ctrl for the next key", modifier: "ctrl" },
  { kind: "modifier", id: "alt", label: "alt", title: "Alt for the next key", modifier: "alt" },
  { kind: "send", id: "tab", label: "tab", title: "Tab", data: "\t" },
  { kind: "arrow", id: "up", label: "↑", title: "Up", arrow: "up" },
  { kind: "arrow", id: "down", label: "↓", title: "Down", arrow: "down" },
  { kind: "arrow", id: "left", label: "←", title: "Left", arrow: "left" },
  { kind: "arrow", id: "right", label: "→", title: "Right", arrow: "right" },
  { kind: "send", id: "tilde", label: "~", title: "Tilde", data: "~" },
  { kind: "send", id: "pipe", label: "|", title: "Pipe", data: "|" },
  { kind: "send", id: "slash", label: "/", title: "Slash", data: "/" },
  { kind: "send", id: "dash", label: "-", title: "Dash", data: "-" },
  { kind: "paste", id: "paste", label: "paste", title: "Paste from the clipboard" },
];

export const INTERRUPT = "\u0003";

const ARROW_FINAL: Record<ArrowKey, string> = { up: "A", down: "B", right: "C", left: "D" };

/** An arrow as the shell expects it: SS3 in application cursor mode (less, vim), CSI otherwise. */
export function arrowSequence(arrow: ArrowKey, applicationCursor: boolean): string {
  return `\u001b${applicationCursor ? "O" : "["}${ARROW_FINAL[arrow]}`;
}

const ESC = "\u001b";

/** The arrow `data` is, in either cursor mode, or `undefined`. */
function arrowFinal(data: string): string | undefined {
  return data.length === 3 && data[0] === ESC && (data[1] === "[" || data[1] === "O") && "ABCD".includes(data[2]!) ? data[2] : undefined;
}

/** The control byte Ctrl makes of one key, or `undefined` for a key Ctrl does not change. */
function controlByte(char: string): string | undefined {
  const lower = char.toLowerCase();
  if (lower >= "a" && lower <= "z") return String.fromCharCode(lower.charCodeAt(0) - 96);
  if (char === " " || char === "@" || char === "2") return "\u0000";
  const table: Record<string, string> = { "[": "\u001b", "\\": "\u001c", "]": "\u001d", "^": "\u001e", "_": "\u001f", "?": "\u007f" };
  return table[char];
}

/**
 * What `data` becomes with the armed modifiers: xterm's `CSI 1;<m>` form for
 * an arrow, the control byte for Ctrl, and ESC first for Alt (the meta
 * convention every shell reads).
 */
export function applyModifiers(data: string, modifiers: ReadonlySet<TouchModifier>): string {
  if (modifiers.size === 0 || !data) return data;
  const ctrl = modifiers.has("ctrl");
  const alt = modifiers.has("alt");
  const arrow = arrowFinal(data);
  if (arrow) return `${ESC}[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${arrow}`;
  const [first = "", ...rest] = [...data];
  const controlled = ctrl ? (controlByte(first) ?? first) + rest.join("") : data;
  return alt ? `${ESC}${controlled}` : controlled;
}

/**
 * Whether a chunk xterm hands over is something typed. Its answers to a
 * program's queries start with ESC; an armed modifier must not spend itself
 * on one of those.
 */
export function isTypedInput(data: string): boolean {
  return data.length > 0 && !data.startsWith(ESC);
}

/** The phone's own text size: a separate setting, so a tap here never resizes the desktop's shells. */
export const COMPACT_FONT_SIZE_KEY = "tau.terminal.compact-font-size.v1";
export const DEFAULT_COMPACT_FONT_SIZE = 11;
/** A tablet's screen is read at arm's length, like a laptop's. */
export const DEFAULT_TABLET_FONT_SIZE = 13;
export const MIN_COMPACT_FONT_SIZE = 8;
export const MAX_COMPACT_FONT_SIZE = 20;

export function compactFontSize(raw: string | null | undefined, tablet = false): number {
  const size = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(size)) return tablet ? DEFAULT_TABLET_FONT_SIZE : DEFAULT_COMPACT_FONT_SIZE;
  return Math.min(MAX_COMPACT_FONT_SIZE, Math.max(MIN_COMPACT_FONT_SIZE, Math.round(size)));
}

/** The shorter side of a tablet's screen is at least this (core's TABLET_SCREEN_MIN_SIDE_PX); a phone's is at most about 440. */
const TABLET_SCREEN_MIN_SIDE_PX = 600;

export function isTabletScreen(screen: { width: number; height: number } | undefined): boolean {
  return Boolean(screen) && Math.min(screen!.width, screen!.height) >= TABLET_SCREEN_MIN_SIDE_PX;
}

export function stepCompactFontSize(size: number, step: 1 | -1): number {
  return compactFontSize(String(size + step));
}

/** Before a finger has moved this far, a touch may still be a tap that focuses the shell. */
export const DRAG_SLOP_PX = 8;

/**
 * Whole lines a vertical drag scrolls, and the part of a line carried to the
 * next move. A finger moving down shows older lines, so the count is negative.
 */
export function dragLines(carry: number, dy: number, cellHeight: number): { lines: number; carry: number } {
  if (!(cellHeight > 0)) return { lines: 0, carry: 0 };
  const total = carry + dy;
  const whole = Math.trunc(total / cellHeight);
  return { lines: whole === 0 ? 0 : -whole, carry: total - whole * cellHeight };
}

/** A finger held this long without moving starts a selection instead of a scroll. */
export const LONG_PRESS_MS = 450;

/** A character cell: column and row, rows counted in the buffer (scrollback included). */
export interface Cell { col: number; row: number }

/** The cell under a point of the screen element, clamped to it; `firstRow` is the buffer row at the top. */
export function cellAt(point: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }, size: { cols: number; rows: number }, firstRow: number): Cell {
  const clamp = (value: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(value)));
  const col = box.width > 0 ? clamp(((point.x - box.left) / box.width) * size.cols, size.cols) : 0;
  const row = box.height > 0 ? clamp(((point.y - box.top) / box.height) * size.rows, size.rows) : 0;
  return { col, row: firstRow + row };
}

/** xterm's `select(column, row, length)` for a drag between two cells, in either direction, both ends included. */
export function selectionRange(anchor: Cell, focus: Cell, cols: number): { column: number; row: number; length: number } {
  const index = (cell: Cell) => cell.row * cols + cell.col;
  const [start, end] = index(anchor) <= index(focus) ? [anchor, focus] : [focus, anchor];
  return { column: start.col, row: start.row, length: index(end) - index(start) + 1 };
}

