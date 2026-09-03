import { useCallback, useEffect, useRef, useState, type AriaRole, type ReactNode } from "react";

/** Fixed-row virtualization used by large navigation and review collections. */
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
}: {
  items: readonly T[];
  itemHeight: number;
  overscan?: number;
  className?: string;
  empty?: ReactNode;
  renderItem(item: T, index: number): ReactNode;
  scrollToIndex?: number;
  role?: AriaRole;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(items.length, 30) });
  const update = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const start = Math.max(0, Math.floor(node.scrollTop / itemHeight) - overscan);
    const end = Math.min(items.length, Math.ceil((node.scrollTop + node.clientHeight) / itemHeight) + overscan);
    setRange((old) => old.start === start && old.end === end ? old : { start, end });
  }, [itemHeight, items.length, overscan]);
  useEffect(() => { update(); }, [update]);
  useEffect(() => {
    if (scrollToIndex === undefined || !ref.current) return;
    const top = scrollToIndex * itemHeight;
    const bottom = top + itemHeight;
    if (top < ref.current.scrollTop) ref.current.scrollTop = top;
    else if (bottom > ref.current.scrollTop + ref.current.clientHeight) ref.current.scrollTop = bottom - ref.current.clientHeight;
  }, [itemHeight, scrollToIndex]);
  const visible = items.slice(range.start, range.end);
  return (
    <div ref={ref} className={className} role={role} aria-label={ariaLabel} onScroll={update}>
      {items.length === 0 ? empty : <>
        <div aria-hidden style={{ height: range.start * itemHeight }} />
        {visible.map((item, offset) => renderItem(item, range.start + offset))}
        <div aria-hidden style={{ height: Math.max(0, (items.length - range.end) * itemHeight) }} />
      </>}
    </div>
  );
}
