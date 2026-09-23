import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { ScreenAction } from "./screen-protocol.js";

/** How long the cursor stays bright after an input, as T3 Code's agent cursor does. */
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

/** True for `ms` after `key` last changed. */
function useFresh(key: string | undefined, ms: number): boolean {
  const [stale, setStale] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!key) return undefined;
    const timer = window.setTimeout(() => setStale(key), ms);
    return () => window.clearTimeout(timer);
  }, [key, ms]);
  return key !== undefined && stale !== key;
}

const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

/**
 * The agent's pointer over a picture of what it drives: a cursor at the last
 * input, a ring for a click, a line for a drag, the text or chord it sent.
 * Fill the picture's box with it; it takes no pointer events. The Screen view
 * uses it over a window; the preview browser can draw the same marks.
 */
export function AgentCursorLayer({ actions, space }: { actions: readonly ScreenAction[]; space?: { width: number; height: number } }) {
  const mark = cursorMark(actions, space);
  const active = useFresh(mark?.id, CURSOR_ACTIVE_MS);
  const labelled = useFresh(mark?.label ? mark.id : undefined, LABEL_VISIBLE_MS);
  if (!mark) return null;
  const clicked = mark.kind === "click" || mark.kind === "double-click" || mark.kind === "right-click";
  return <div className={mark.failed ? "agent-cursor-layer failed" : "agent-cursor-layer"} aria-hidden="true" data-agent-cursor>
    {mark.at && mark.to ? <svg className="agent-cursor-drag" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1={mark.at.x * 100} y1={mark.at.y * 100} x2={mark.to.x * 100} y2={mark.to.y * 100} vectorEffect="non-scaling-stroke" />
    </svg> : null}
    {mark.at ? <div
      className="agent-cursor"
      style={{ left: percent((mark.to ?? mark.at).x), top: percent((mark.to ?? mark.at).y), opacity: active ? 1 : 0.35 }}
    >
      {clicked && active ? <span key={mark.id} className="agent-cursor-ping" /> : null}
      <MousePointer2 size={18} strokeWidth={2} />
      {mark.label && labelled ? <span className="agent-cursor-label">{mark.label}</span> : null}
    </div> : null}
    {!mark.at && mark.label && labelled ? <span className="agent-cursor-label corner">{mark.label}</span> : null}
  </div>;
}
