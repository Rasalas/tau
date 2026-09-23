import { useCallback, useEffect, useMemo, useRef, useState, type AriaRole, type ReactNode } from "react";

/** Offsets of each row's top, and the total height last, for rows of known heights. */
function rowOffsets<T>(items: readonly T[], itemHeight: number | ((item: T) => number)): number[] | undefined {
  if (typeof itemHeight === "number") return undefined;
  const offsets = new Array<number>(items.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < items.length; index += 1) offsets[index + 1] = offsets[index]! + itemHeight(items[index]!);
  return offsets;
}

/** The last row whose top is at or above `y`. */
function rowAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** Virtualization used by large navigation and review collections; rows are fixed or known per item. */
export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 6,
  className,
  empty,
  renderItem,
  scrollToIndex,
  role,
  ariaLabel,
  id,
}: {
  items: readonly T[];
  itemHeight: number | ((item: T) => number);
  overscan?: number;
  className?: string;
  empty?: ReactNode;
  renderItem(item: T, index: number): ReactNode;
  scrollToIndex?: number;
  role?: AriaRole;
  ariaLabel?: string;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const offsets = useMemo(() => rowOffsets(items, itemHeight), [itemHeight, items]);
  const top = useCallback((index: number) => {
    const at = Math.min(Math.max(0, index), items.length);
    return offsets ? offsets[at]! : at * (itemHeight as number);
  }, [itemHeight, items.length, offsets]);
  const [range, setRange] = useState({ start: 0, end: Math.min(items.length, 30) });
  const update = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    let start: number;
    let end: number;
    if (offsets) {
      start = Math.max(0, rowAt(offsets, node.scrollTop) - overscan);
      end = Math.min(items.length, rowAt(offsets, node.scrollTop + node.clientHeight) + 1 + overscan);
    } else {
      const height = itemHeight as number;
      start = Math.max(0, Math.floor(node.scrollTop / height) - overscan);
      end = Math.min(items.length, Math.ceil((node.scrollTop + node.clientHeight) / height) + overscan);
    }
    setRange((old) => old.start === start && old.end === end ? old : { start, end });
  }, [itemHeight, items.length, offsets, overscan]);
  useEffect(() => { update(); }, [update]);
  useEffect(() => {
    if (scrollToIndex === undefined || !ref.current || scrollToIndex >= items.length) return;
    const rowTop = top(scrollToIndex);
    const rowBottom = top(scrollToIndex + 1);
    if (rowTop < ref.current.scrollTop) ref.current.scrollTop = rowTop;
    else if (rowBottom > ref.current.scrollTop + ref.current.clientHeight) ref.current.scrollTop = rowBottom - ref.current.clientHeight;
  }, [items.length, scrollToIndex, top]);
  const visible = items.slice(range.start, range.end);
  const total = top(items.length);
  return (
    <div ref={ref} id={id} className={className} role={role} aria-label={ariaLabel} onScroll={update}>
      {items.length === 0 ? empty : <>
        <div aria-hidden style={{ height: top(range.start) }} />
        {visible.map((item, offset) => renderItem(item, range.start + offset))}
        <div aria-hidden style={{ height: Math.max(0, total - top(Math.min(range.end, items.length))) }} />
      </>}
    </div>
  );
}
