import type { MenuItemConstructorOptions } from "electron";
import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu.js";

export interface ContextMenuPorts {
  /** `Menu.buildFromTemplate(template).popup(...)` over the workbench window; `closed` runs when it goes. */
  popup(template: MenuItemConstructorOptions[], point: MenuPoint, closed: () => void): void;
  /** Electron may report the close before the click; the answer waits this long for one. */
  schedule?(run: () => void, ms: number): void;
  platform: NodeJS.Platform;
}

/** A heading is a native header on macOS 14 and later; elsewhere a disabled line. */
function template(entries: readonly NativeMenuEntry[], platform: NodeJS.Platform, choose: (id: string) => void): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if (entry.type === "separator") return { type: "separator" };
    if (entry.type === "heading") return platform === "darwin" ? { type: "header", label: entry.label } : { label: entry.label, enabled: false };
    if (entry.submenu) return { label: entry.label, enabled: entry.enabled !== false, submenu: template(entry.submenu, platform, choose) };
    return {
      label: entry.label,
      enabled: entry.enabled !== false,
      ...(entry.checked ? { type: "checkbox" as const, checked: true } : {}),
      click: () => choose(entry.id),
    };
  });
}

/**
 * Shows the menu and answers with the id the user chose, or undefined when
 * it closed without a choice. The window's process draws it because the
 * sandboxed page has no menu of its own to offer (ADR 0021).
 */
export function showWindowContextMenu(ports: ContextMenuPorts, entries: readonly NativeMenuEntry[], point: MenuPoint): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };
    const schedule = ports.schedule ?? ((run, ms) => { setTimeout(run, ms); });
    ports.popup(template(entries, ports.platform, finish), point, () => schedule(() => finish(undefined), 50));
  });
}
