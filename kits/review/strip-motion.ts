import { useLayoutEffect, useRef, useState } from "react";

/** How often `value` changed since it was first known; keying an element by it replays its animation. */
export function useChangeCount(value: unknown): number {
  const last = useRef<{ value: unknown } | undefined>(undefined);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    if (value === undefined) return;
    if (last.current && !Object.is(last.current.value, value)) setCount((n) => n + 1);
    last.current = { value };
  }, [value]);
  return count;
}

export interface Presence<T> { item: T; key: string; slot: number; state: "settled" | "arriving" | "leaving"; order: number }

/**
 * The rows to draw: the current ones, and for `ms` the ones just gone, at
 * their old place, so they can fold away. A row that came after the first
 * draw of `scope` arrives; one there from the start, or after `scope`
 * changes, is simply there.
 */
export function usePresence<T>(items: readonly T[], keyOf: (item: T) => string, scope: string, ms: number): Presence<T>[] {
  const seen = useRef<{ scope: string; rows: Map<string, { item: T; slot: number }>; arrived: Map<string, number> } | undefined>(undefined);
  const [leaving, setLeaving] = useState<{ scope: string; rows: Map<string, { item: T; slot: number }> }>({ scope, rows: new Map() });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const fresh = seen.current?.scope !== scope;
  const arrived = fresh ? new Map<string, number>() : seen.current!.arrived;
  if (!fresh) {
    let order = 0;
    for (const item of items) {
      const key = keyOf(item);
      if (!seen.current!.rows.has(key) && !arrived.has(key) && !leaving.rows.has(key)) arrived.set(key, order++);
    }
  }
  const current = new Map(items.map((item, slot) => [keyOf(item), { item, slot }]));
  useLayoutEffect(() => {
    const before = seen.current?.scope === scope ? seen.current.rows : undefined;
    seen.current = { scope, rows: current, arrived };
    for (const key of [...arrived.keys()]) if (!current.has(key)) arrived.delete(key);
    const gone = before ? [...before].filter(([key]) => !current.has(key)) : [];
    const back = [...current.keys()].filter((key) => leaving.rows.has(key));
    if (leaving.scope !== scope) { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); setLeaving({ scope, rows: new Map() }); return; }
    if (!gone.length && !back.length) return;
    setLeaving((value) => {
      const rows = new Map(value.rows);
      for (const key of back) { rows.delete(key); clearTimeout(timers.current.get(key)); timers.current.delete(key); }
      for (const [key, row] of gone) rows.set(key, row);
      return { scope, rows };
    });
    for (const [key] of gone) {
      clearTimeout(timers.current.get(key));
      timers.current.set(key, setTimeout(() => {
        timers.current.delete(key);
        setLeaving((value) => { const rows = new Map(value.rows); rows.delete(key); return { ...value, rows }; });
      }, ms));
    }
  });
  useLayoutEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  const rows: Presence<T>[] = items.map((item, slot) => {
    const key = keyOf(item), order = arrived.get(key);
    return { item, key, slot, state: order === undefined ? "settled" : "arriving", order: order ?? 0 };
  });
  if (leaving.scope === scope) for (const [key, row] of leaving.rows) {
    if (current.has(key)) continue;
    rows.splice(Math.min(row.slot, rows.length), 0, { item: row.item, key, slot: row.slot, state: "leaving", order: 0 });
  }
  return rows;
}
