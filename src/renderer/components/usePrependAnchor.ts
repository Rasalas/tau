import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** The public part of TanStack's virtualizer this hook reads. */
export interface PrependAnchorVirtualizer {
  scrollOffset: number | null;
  scrollRect: { height: number } | null;
  measurementsCache: ReadonlyArray<{ start: number }>;
  getTotalSize(): number;
  getVirtualItemForOffset(offset: number): { index: number; key: unknown; start: number } | undefined;
}

/** The row that led the viewport when older rows were prepended, in virtualizer coordinates. */
interface PrependPin {
  messageId: string;
  /** Row start minus scroll offset. */
  offset: number;
  /** Last scrollTop this pin wrote; a scroll to anywhere else releases it. */
  scrollTop: number;
}

const SCROLL_TOLERANCE_PX = 1;

function rowStart(virtualizer: PrependAnchorVirtualizer, index: number): number | undefined {
  // getTotalSize folds pending measurements into measurementsCache first.
  virtualizer.getTotalSize();
  return virtualizer.measurementsCache[index]?.start;
}

function pinTarget(virtualizer: PrependAnchorVirtualizer, pin: PrependPin, positions: ReadonlyMap<string, number>): number | undefined {
  const index = positions.get(pin.messageId);
  const start = index === undefined ? undefined : rowStart(virtualizer, index);
  return start === undefined ? undefined : Math.max(0, start - pin.offset);
}

/**
 * Keeps the leading row in place when rows are prepended, before the frame is
 * painted, while the new rows above it are still estimates and while they get
 * measured. The virtualizer compensates for nothing on its own here.
 * Returns the rows the pinned viewport needs mounted, for the range extractor.
 */
export function usePrependAnchor(
  virtualizerRef: RefObject<PrependAnchorVirtualizer | undefined>,
  scrollRef: RefObject<HTMLDivElement | null>,
  positions: ReadonlyMap<string, number>,
  firstId: string | undefined,
): () => [number, number] | undefined {
  const committedFirstId = useRef(firstId);
  const pin = useRef<PrependPin | undefined>(undefined);
  const previousFirstId = committedFirstId.current;
  const prepended = previousFirstId !== undefined && previousFirstId !== firstId
    ? positions.get(previousFirstId) ?? 0
    : 0;

  const pinnedRows = useCallback((): [number, number] | undefined => {
    const virtualizer = virtualizerRef.current;
    if (!virtualizer || (!pin.current && prepended === 0)) return undefined;
    // In the commit that prepends, the scroll offset still belongs to the old rows.
    const target = pin.current
      ? pinTarget(virtualizer, pin.current, positions)
      : (virtualizer.scrollOffset ?? 0) + (rowStart(virtualizer, prepended) ?? 0);
    if (target === undefined) return undefined;
    const first = virtualizer.getVirtualItemForOffset(target)?.index;
    const last = virtualizer.getVirtualItemForOffset(target + (virtualizer.scrollRect?.height ?? 0))?.index;
    if (first === undefined || last === undefined) return undefined;
    // One row either side: measuring the new rows can still move the window a little.
    return [Math.max(0, first - 1), Math.min(positions.size - 1, last + 1)];
  }, [positions, prepended, virtualizerRef]);

  useLayoutEffect(() => {
    committedFirstId.current = firstId;
    const node = scrollRef.current;
    const virtualizer = virtualizerRef.current;
    if (!node || !virtualizer) return;
    if (!pin.current && prepended > 0) {
      const top = node.scrollTop + (rowStart(virtualizer, prepended) ?? 0);
      const lead = virtualizer.getVirtualItemForOffset(top);
      if (lead) pin.current = { messageId: String(lead.key), offset: lead.start - top, scrollTop: Number.NaN };
    }
    const current = pin.current;
    if (!current) return;
    const target = pinTarget(virtualizer, current, positions);
    if (target === undefined) {
      pin.current = undefined;
      return;
    }
    if (target === current.scrollTop) return;
    node.scrollTop = target;
    current.scrollTop = target;
  });

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // The reader, a jump, or a clamp moved the transcript elsewhere: stop holding it.
    const release = () => {
      const current = pin.current;
      if (current && Math.abs(node.scrollTop - current.scrollTop) > SCROLL_TOLERANCE_PX) pin.current = undefined;
    };
    node.addEventListener("scroll", release, { passive: true });
    return () => node.removeEventListener("scroll", release);
  }, [scrollRef]);

  return pinnedRows;
}
