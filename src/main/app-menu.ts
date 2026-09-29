import type { MenuItemConstructorOptions } from "electron";
import { APP_MENU_CHORDS, type WindowMenuAction } from "../shared/window-shell.js";

export type ZoomDirection = "in" | "out" | "reset";

export interface AppMenuHandlers {
  checkForUpdates(): void;
  /** Settings, About and Paste as Text: the page carries them out. */
  pageAction(action: WindowMenuAction): void;
  /** Always the workbench's own page, whichever view has focus. */
  zoom(direction: ZoomDirection): void;
}

/** `mod+shift+v` as Electron spells an accelerator: `CmdOrCtrl+Shift+V`. */
export function accelerator(chord: string): string {
  const parts = chord.split("+");
  // `mod++` splits into a trailing empty pair: the key is the plus sign.
  const key = chord.endsWith("++") ? "Plus" : parts.pop()!;
  const modifiers = (chord.endsWith("++") ? parts.slice(0, -2) : parts).map((part) => part === "mod" ? "CmdOrCtrl" : part[0]!.toUpperCase() + part.slice(1));
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** Electron's own zoom roles step by half a level; so does this, within Chromium's range. */
export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 0;
  const next = current + (direction === "in" ? 0.5 : -0.5);
  return Math.min(5, Math.max(-5, next));
}

/**
 * The app menu. The zoom items are not Electron's zoom roles:
 * those zoom whatever has focus, which is the preview's page while it has the
 * keyboard. A kit that wants ⌘+, ⌘− and ⌘0 for a view of its own takes them in
 * that view's `before-input-event` and calls `preventDefault`, which also keeps
 * these accelerators from firing.
 */
export function appMenuTemplate(platform: string, appName: string, handlers: AppMenuHandlers): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  // The page binds ⌘, and ⇧⌘V itself; only a click, which the page never sees, goes through here.
  const clickOnly = (action: WindowMenuAction) => (_item: unknown, _window: unknown, event: { triggeredByAccelerator?: boolean }) => {
    if (!event.triggeredByAccelerator) handlers.pageAction(action);
  };
  const settings: MenuItemConstructorOptions = { label: "Settings…", accelerator: accelerator(APP_MENU_CHORDS.settings), click: clickOnly("open-settings") };
  const about: MenuItemConstructorOptions = { label: `About ${appName}`, click: () => handlers.pageAction("open-about") };
  const checkForUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: () => handlers.checkForUpdates() };
  const zoom = (direction: ZoomDirection) => () => handlers.zoom(direction);
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: appName,
      submenu: [
        about,
        checkForUpdates,
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    { label: "File", submenu: mac ? [{ role: "close" }] : [settings, { type: "separator" }, { role: "quit" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { label: "Paste as Text", accelerator: accelerator(APP_MENU_CHORDS.pasteAsText), click: clickOnly("paste-as-text") },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
        ...(mac ? [{ type: "separator" as const }, { label: "Speech", submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }] }] : []),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", accelerator: accelerator(APP_MENU_CHORDS.actualSize), click: zoom("reset") },
        { label: "Zoom In", accelerator: accelerator(APP_MENU_CHORDS.zoomIn), click: zoom("in") },
        // ⌘+ on layouts where + is its own key; hidden, it only listens.
        { label: "Zoom In", accelerator: accelerator(APP_MENU_CHORDS.zoomInPlus), visible: false, click: zoom("in") },
        { label: "Zoom Out", accelerator: accelerator(APP_MENU_CHORDS.zoomOut), click: zoom("out") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: mac ? [checkForUpdates] : [checkForUpdates, about] },
  );
  return template;
}
