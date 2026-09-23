import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { ScreenAction } from "./screen-protocol.js";
import { CURSOR_ACTIVE_MS, LABEL_VISIBLE_MS, cursorMark } from "./agent-cursor-marks.js";

export { CURSOR_ACTIVE_MS, LABEL_VISIBLE_MS, chord, cursorMark, describeAction, type CursorMark } from "./agent-cursor-marks.js";

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
