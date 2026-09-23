/**
 * The rail's multi-selection, as T3 Code's sidebar has it: mod-click toggles
 * a row, shift-click (or shift+arrow) selects the run from the anchor, and a
 * plain click or Escape ends it. The anchor is the last row toggled or opened.
 */
export interface RailSelection {
  ids: ReadonlySet<string>;
  anchor?: string;
}

export const NO_SELECTION: RailSelection = { ids: new Set() };

export function toggleSelected(selection: RailSelection, id: string): RailSelection {
  const ids = new Set(selection.ids);
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  return { ids, anchor: id };
}

/** The rows from the anchor to `id` in `order`; without an anchor in view, `id` alone. */
export function selectRange(selection: RailSelection, id: string, order: readonly string[], fallbackAnchor?: string): RailSelection {
  const anchor = selection.anchor ?? fallbackAnchor ?? id;
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return { ids: new Set([id]), anchor: id };
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { ids: new Set(order.slice(start, end + 1)), anchor };
}

/** What the bulk actions touch: selected rows still in view, in rail order. */
export function selectedInOrder(selection: RailSelection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.has(id));
}
