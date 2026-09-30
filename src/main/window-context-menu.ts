import type { MenuItemConstructorOptions, NativeImage } from "electron";
import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu.js";

export interface ContextMenuPorts {
  /** `Menu.buildFromTemplate(template).popup(...)` over the workbench window; `closed` runs when it goes. */
  popup(template: MenuItemConstructorOptions[], point: MenuPoint, closed: () => void): void;
  /** Electron may report the close before the click; the answer waits this long for one. */
  schedule?(run: () => void, ms: number): void;
  platform: NodeJS.Platform;
  /** The image a named icon draws as, where this platform's menus take one. */
  icon?(name: string): NativeImage | undefined;
}

/** The keys `formatKeyChord` spells as a glyph or a word, in Electron's accelerator spelling. */
const KEYS: Record<string, string> = {
  Esc: "Escape", "↵": "Enter", "↑": "Up", "↓": "Down", "←": "Left", "→": "Right", "⌫": "Backspace", "⌦": "Delete", "⇥": "Tab",
  Space: "Space", "+": "Plus", Pageup: "PageUp", Pagedown: "PageDown", Home: "Home", End: "End", Insert: "Insert",
};
const MAC_MODIFIERS = /^([⌃⌥⇧⌘]*)(.+)$/u;
const MAC_GLYPHS: Record<string, string> = { "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌘": "Cmd" };
const OTHER_MODIFIERS: Record<string, string> = { Ctrl: "Ctrl", Win: "Super", Alt: "Alt", Shift: "Shift" };

/**
 * The accelerator a shortcut label the page shows (⌘⇧S, Ctrl+Shift+S) names,
 * or undefined for a label that is not one.
 */
export function acceleratorOf(label: string, platform: NodeJS.Platform): string | undefined {
  let modifiers: string[];
  let key: string;
  if (platform === "darwin") {
    const match = MAC_MODIFIERS.exec(label);
    if (!match) return undefined;
    modifiers = Object.entries(MAC_GLYPHS).filter(([glyph]) => match[1]!.includes(glyph)).map(([, name]) => name);
    key = match[2]!;
  } else {
    const plus = label.endsWith("++");
    const parts = (plus ? label.slice(0, -2) : label).split("+");
    key = plus ? "+" : parts.pop()!;
    const named = parts.map((part) => OTHER_MODIFIERS[part]);
    if (named.some((part) => !part)) return undefined;
    modifiers = named as string[];
  }
  const accelerated = KEYS[key] ?? (/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|[`\-=[\]\\;',./])$/u.test(key) ? key : undefined);
  return accelerated ? [...modifiers, accelerated].join("+") : undefined;
}

/** Electron reads `&` as a mnemonic mark and drops it; `&&` is a literal one. */
const literal = (label: string) => label.replaceAll("&", "&&");

/** A heading is a native header on macOS 14 and later; elsewhere a disabled line. */
function template(entries: readonly NativeMenuEntry[], ports: ContextMenuPorts, choose: (id: string) => void): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if (entry.type === "separator") return { type: "separator" };
    if (entry.type === "heading") return ports.platform === "darwin" ? { type: "header", label: literal(entry.label) } : { label: literal(entry.label), enabled: false };
    const icon = entry.icon ? ports.icon?.(entry.icon) : undefined;
    const common = { label: literal(entry.badge ? `${entry.label} (${entry.badge})` : entry.label), enabled: entry.enabled !== false, ...(icon ? { icon } : {}) };
    if (entry.submenu) return { ...common, submenu: template(entry.submenu, ports, choose) };
    // A chord is shown only, the page's own keybinding does the work; any other hint is a sublabel.
    const accelerator = entry.hint ? acceleratorOf(entry.hint, ports.platform) : undefined;
    return {
      ...common,
      ...(accelerator ? { accelerator, registerAccelerator: false } : entry.hint ? { sublabel: entry.hint } : {}),
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
    ports.popup(template(entries, ports, finish), point, () => schedule(() => finish(undefined), 50));
  });
}
