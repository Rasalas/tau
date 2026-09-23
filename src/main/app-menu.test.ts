import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { accelerator, appMenuTemplate, nextZoomLevel } from "./app-menu.js";

function handlers() {
  return { checkForUpdates: vi.fn(), pageAction: vi.fn(), zoom: vi.fn() };
}

function submenu(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const found = template.find((entry) => entry.label === label || entry.role === label);
  return (found?.submenu ?? []) as MenuItemConstructorOptions[];
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label && entry.visible !== false);
  if (!found) throw new Error(`No item ${label}`);
  return found;
}

const click = (entry: MenuItemConstructorOptions, triggeredByAccelerator = false) =>
  (entry.click as unknown as (item: unknown, window: unknown, event: { triggeredByAccelerator: boolean }) => void)({}, undefined, { triggeredByAccelerator });

describe("the app menu", () => {
  it("spells the workbench's chords as Electron accelerators", () => {
    expect(accelerator("mod+shift+v")).toBe("CmdOrCtrl+Shift+V");
    expect(accelerator("mod++")).toBe("CmdOrCtrl+Plus");
    expect(accelerator("mod+-")).toBe("CmdOrCtrl+-");
    expect(accelerator("mod+,")).toBe("CmdOrCtrl+,");
  });

  it("zooms the workbench itself, whatever view has focus", () => {
    const on = handlers();
    const view = submenu(appMenuTemplate("darwin", "Tau", on), "View");
    click(item(view, "Zoom In"));
    click(item(view, "Zoom Out"));
    click(item(view, "Actual Size"));
    expect(on.zoom.mock.calls).toEqual([["in"], ["out"], ["reset"]]);
    expect(view.map((entry) => entry.accelerator).filter(Boolean)).toEqual(["CmdOrCtrl+0", "CmdOrCtrl+=", "CmdOrCtrl+Plus", "CmdOrCtrl+-"]);
    expect(view.some((entry) => entry.role === "zoomIn" || entry.role === "zoomOut" || entry.role === "resetZoom")).toBe(false);
  });

  it("steps zoom by half a level and keeps it in range", () => {
    expect(nextZoomLevel(0, "in")).toBe(0.5);
    expect(nextZoomLevel(0, "out")).toBe(-0.5);
    expect(nextZoomLevel(3, "reset")).toBe(0);
    expect(nextZoomLevel(5, "in")).toBe(5);
    expect(nextZoomLevel(-5, "out")).toBe(-5);
  });

  it("hands Paste as Text and Settings to the page only when clicked, since the page sees the chord itself", () => {
    const on = handlers();
    const template = appMenuTemplate("darwin", "Tau", on);
    const paste = item(submenu(template, "Edit"), "Paste as Text");
    click(paste, true);
    expect(on.pageAction).not.toHaveBeenCalled();
    click(paste);
    expect(on.pageAction).toHaveBeenCalledWith("paste-as-text");
    const settings = item(submenu(template, "Tau"), "Settings…");
    click(settings, true);
    click(settings);
    expect(on.pageAction.mock.calls).toEqual([["paste-as-text"], ["open-settings"]]);
  });

  it("keeps About, Settings and updates under the app's name on macOS, in File and Help elsewhere", () => {
    const mac = appMenuTemplate("darwin", "Tau", handlers());
    expect(submenu(mac, "Tau").filter((entry) => entry.label).map((entry) => entry.label)).toEqual(["About Tau", "Check for Updates…", "Settings…"]);
    const windows = appMenuTemplate("win32", "Tau", handlers());
    expect(windows.map((entry) => entry.label ?? entry.role)).toEqual(["File", "Edit", "View", "windowMenu", "help"]);
    expect(submenu(windows, "File").map((entry) => entry.label ?? entry.role ?? entry.type)).toEqual(["Settings…", "separator", "quit"]);
    const help = submenu(windows, "help");
    click(item(help, "About Tau"));
    click(item(help, "Check for Updates…"));
  });
});
