import type { ScreenAction } from "./screen-protocol.js";

/*
 * The agent cursor's marks, without React: the Screen view draws them as
 * components, the host sends them into the preview page.
 */

/** How long the agent cursor stays bright after an input. */
export const CURSOR_ACTIVE_MS = 700;
/** How long typed text or a chord stays beside the cursor. */
export const LABEL_VISIBLE_MS = 1_600;

const KEY_GLYPHS: Record<string, string> = {
  cmd: "⌘", command: "⌘", meta: "⌘", shift: "⇧", option: "⌥", alt: "⌥", ctrl: "⌃", control: "⌃", fn: "fn",
  return: "↩", enter: "↩", tab: "⇥", escape: "⎋", esc: "⎋", delete: "⌫", backspace: "⌫", space: "Space",
  up: "↑", down: "↓", left: "←", right: "→", home: "↖", end: "↘", pageup: "⇞", pagedown: "⇟",
};

/** `["cmd", "shift", "4"]` → `⌘⇧4`. */
export function chord(keys: readonly string[]): string {
  return keys.map((key) => KEY_GLYPHS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)).join("");
}

/** One line for an action: the status line's and the label's words. */
export function describeAction(action: ScreenAction): string {
  const failed = action.status === "failed" ? " (failed)" : "";
  switch (action.kind) {
    case "click": return `Clicked${failed}`;
    case "double-click": return `Double-clicked${failed}`;
    case "right-click": return `Right-clicked${failed}`;
    case "drag": return `Dragged${failed}`;
    case "type": return action.text ? `Typed “${action.text}”${failed}` : `Typed${failed}`;
    case "key": return action.keys?.length ? `Pressed ${chord(action.keys)}${failed}` : `Pressed a key${failed}`;
    case "scroll": return `Scrolled ${action.direction ?? ""}`.trimEnd() + failed;
  }
}

/** Where the overlay draws, as fractions of the picture, so any size of the same window fits. */
export interface CursorMark {
  /** The action the mark is about. */
  id: string;
  kind: ScreenAction["kind"];
  at?: { x: number; y: number };
  to?: { x: number; y: number };
  /** Typed text or a chord, drawn beside the cursor. */
  label?: string;
  failed: boolean;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The newest action as a mark. The cursor stays where the last placed input
 * landed, so a chord typed after a click is shown beside that click.
 */
export function cursorMark(actions: readonly ScreenAction[], fallbackSpace?: { width: number; height: number }): CursorMark | undefined {
  const latest = actions.at(-1);
  if (!latest) return undefined;
  const placed = [...actions].reverse().find((action) => action.point);
  const space = placed?.space ?? fallbackSpace;
  const fraction = (point: { x: number; y: number } | undefined) =>
    point && space && space.width > 0 && space.height > 0 ? { x: clamp(point.x / space.width), y: clamp(point.y / space.height) } : undefined;
  const label = latest.kind === "type" ? latest.text : latest.kind === "key" && latest.keys?.length ? chord(latest.keys) : undefined;
  const at = fraction(placed?.point);
  const to = placed === latest ? fraction(latest.to) : undefined;
  return {
    id: latest.id,
    kind: latest.kind,
    ...(at ? { at } : {}),
    ...(to ? { to } : {}),
    ...(label ? { label } : {}),
    failed: latest.status === "failed",
  };
}
