import type { PaletteItem, PaletteMenu, PaletteSearchContext } from "./extension-system";
import { menuRows, scoreCommand, type PaletteCommand, type PaletteRow } from "./palette-results";

export interface MenuHit { key: string; item: PaletteItem; parent: PaletteMenu; label: string }
/** Bound third-party enumeration as well as the number of rows it can contribute. */
export const MENU_SEARCH_LIMIT = 32;
export const MENU_ITEM_LIMIT = 200;
export const MENU_SEARCH_TIMEOUT = 1500;

/** Only explicitly searchable roots are read. `run` and `stage` are never called here. */
export function searchPaletteMenus(commands: readonly PaletteCommand[], query: string, context: PaletteSearchContext, publish: (hits: readonly MenuHit[]) => void): () => void {
  if (context.signal.aborted) return () => undefined;
  const roots = commands.filter((command) => command.submenu?.searchable && scoreCommand(command, query) < 2).slice(0, MENU_SEARCH_LIMIT);
  const controller = new AbortController();
  const search = { ...context, signal: controller.signal };
  const answers = new Map<string, MenuHit[]>();
  const disposers: Array<() => void> = [];
  const stopAll = () => { controller.abort(); for (const dispose of disposers) dispose(); };
  context.signal.addEventListener("abort", stopAll, { once: true });
  const update = () => { if (!controller.signal.aborted) publish([...answers.values()].flat().slice(0, 8)); };
  for (const command of roots) {
    const menu = command.submenu!;
    let settled = false;
    const stop = () => { settled = true; clearTimeout(timer); };
    const timer = setTimeout(stop, MENU_SEARCH_TIMEOUT);
    disposers.push(stop);
    const finish = (items: readonly PaletteItem[]) => {
      if (settled || context.signal.aborted) return;
      settled = true;
      clearTimeout(timer);
      const rows = menuRows(items.slice(0, MENU_ITEM_LIMIT), query, menu.searches).slice(0, 3);
      answers.set(command.id, rows.flatMap((row) => row.kind !== "item" ? [] : [{
        key: `menu-hit:${command.id}:${row.item.id}`, parent: menu, label: row.item.label,
        item: { ...row.item, label: `${menu.title}: ${row.item.label}`,
          unavailable: () => command.unavailable?.() ?? row.item.unavailable?.(),
        },
      }]));
      update();
    };
    // Promise adoption also catches a synchronous throw and includes lazy module loading in the budget.
    void Promise.resolve().then(() => controller.signal.aborted ? [] : menu.items(query, search)).then(finish).catch(stop);
  }
  return () => { context.signal.removeEventListener("abort", stopAll); stopAll(); };
}

export function menuHitRows(hits: readonly MenuHit[]): PaletteRow[] {
  return hits.length ? [{ kind: "head", key: "head:menus", label: "In menus" }, ...hits.map((hit): PaletteRow => ({ kind: "item", key: hit.key, item: hit.item, source: "In menus" }))] : [];
}
