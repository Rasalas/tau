import type { CSSProperties, HTMLAttributes } from "react";

const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;

/** Where to cut: a path keeps a short last segment, anything else `tail` characters; too short to be worth it, nothing. */
export function splitMiddle(value: string, tail?: number): { head: string; tail: string } | undefined {
  // Code points, so a cut never lands inside a surrogate pair.
  const chars = Array.from(value);
  let keep = tail ?? DEFAULT_TAIL;
  if (tail === undefined) {
    const slash = chars.lastIndexOf("/");
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1;
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return undefined;
  const cut = chars.length - keep;
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

// Inline, so the component adds nothing to the first-paint stylesheet.
const OUTER: CSSProperties = { display: "inline-flex", minWidth: 0, maxWidth: "100%", overflow: "hidden", whiteSpace: "nowrap", verticalAlign: "bottom" };
const HEAD: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const TAIL: CSSProperties = { flexShrink: 0 };

/** Cuts in the middle, as Finder does. No measuring; both halves are real text, so copy gets the whole value. */
export function MiddleTruncate({ value, tail, style, ...props }: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: string;
  /** Characters kept at the end; defaults to a short last path segment, or 10. */
  tail?: number;
}) {
  const split = splitMiddle(value, tail);
  return (
    <span {...props} style={style ? { ...OUTER, ...style } : OUTER}>
      {split ? <><span style={HEAD}>{split.head}</span><span style={TAIL}>{split.tail}</span></> : <span style={HEAD}>{value}</span>}
    </span>
  );
}
