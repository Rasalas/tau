import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { TranscriptRowSizes } from "./transcript-row-sizes";

type Layout = ReadonlyArray<{ key: unknown; start: number; end: number }>;

/** The public part of TanStack's virtualizer this hook reads and writes. */
export interface LeadingRowVirtualizer {
  scrollOffset: number | null;
  scrollRect: { height: number } | null;
  measurementsCache: Layout;
  getTotalSize(): number;
}

/** The row the reader sees at the viewport top, where the committed layout put it. */
interface LeadingRow {
  key: string;
  start: number;
  /** The scrollTop that goes with `start`; a scroll anywhere else picks the row anew. */
  scrollTop: number;
}

const OWN_WRITE_TOLERANCE_PX = 1;

function firstRowEndingBelow(layout: Layout, top: number): number {
  let low = 0;
  let high = layout.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (layout[middle]!.end > top) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The first row at the viewport top that `layout` placed at its measured
 * size. A row that has just come in at the edge is still an estimate; the
 * rows below it are what the reader has been looking at.
 */
function leadingRow(layout: Layout, top: number, height: number, sizes: TranscriptRowSizes, generation: number): LeadingRow | undefined {
  const first = firstRowEndingBelow(layout, top);
  if (first >= layout.length) return undefined;
  for (let index = first; index < layout.length && layout[index]!.start < top + height; index += 1) {
    const key = String(layout[index]!.key);
    if (sizes.measuredBefore(key, generation)) return { key, start: layout[index]!.start, scrollTop: top };
  }
  return { key: String(layout[first]!.key), start: layout[first]!.start, scrollTop: top };
}

/** How far `layout` moved the leading row from where the committed layout had it. */
function shiftOf(lead: LeadingRow | undefined, layout: Layout, positions: ReadonlyMap<string, number>): number {
  if (!lead) return 0;
  const index = positions.get(lead.key);
  const start = index === undefined ? undefined : layout[index]?.start;
  return start === undefined ? 0 : start - lead.start;
}

/**
 * Keeps the leading row where the reader sees it whenever rows above it
 * change height or arrive: measured for the first time while scrolling up,
 * re-measured, re-estimated, or prepended as an older page. Call it before
 * the virtualizer picks its rows: it moves the virtualizer's offset to where
 * the correction puts the viewport, so the rows mounted in this commit are
 * the ones the reader will see, and writes `scrollTop` before paint.
 */
export function useLeadingRowAnchor(
  virtualizer: LeadingRowVirtualizer,
  scrollRef: RefObject<HTMLDivElement | null>,
  positions: ReadonlyMap<string, number>,
  sizes: TranscriptRowSizes,
): void {
  const lead = useRef<LeadingRow | undefined>(undefined);
  const committed = useRef<{ layout: Layout; generation: number }>({ layout: [], generation: 0 });

  const generation = sizes.beginLayout();
  // Folds pending measurements in, as the render's own layout will.
  virtualizer.getTotalSize();
  const layout = virtualizer.measurementsCache;
  const shift = shiftOf(lead.current, layout, positions);
  if (shift !== 0) virtualizer.scrollOffset = Math.max(0, lead.current!.scrollTop + shift);

  useLayoutEffect(() => {
    committed.current = { layout, generation };
    const node = scrollRef.current;
    if (!node) return;
    const current = lead.current;
    let top = current?.scrollTop ?? node.scrollTop;
    const delta = shiftOf(current, layout, positions);
    if (delta !== 0) {
      node.scrollTop += delta;
      top = node.scrollTop;
      virtualizer.scrollOffset = top;
    }
    lead.current = leadingRow(layout, top, virtualizer.scrollRect?.height ?? node.clientHeight, sizes, generation);
  });

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Capture phase: runs before the virtualizer renders for the same event.
    const onScroll = () => {
      const current = lead.current;
      if (current && Math.abs(node.scrollTop - current.scrollTop) <= OWN_WRITE_TOLERANCE_PX) return;
      const { layout: latest, generation: latestGeneration } = committed.current;
      lead.current = leadingRow(latest, node.scrollTop, node.clientHeight, sizes, latestGeneration);
    };
    node.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => node.removeEventListener("scroll", onScroll, { capture: true });
  }, [scrollRef, sizes]);
}
