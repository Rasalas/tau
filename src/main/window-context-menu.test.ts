import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { decodeNativeMenu } from "../shared/context-menu.js";
import { showWindowContextMenu } from "./window-context-menu.js";

function fakePopup(platform: NodeJS.Platform = "darwin") {
  const shown: { template?: MenuItemConstructorOptions[]; point?: { x: number; y: number }; closed?: () => void } = {};
  const pending: Array<() => void> = [];
  return {
    shown,
    flush: () => pending.splice(0).forEach((run) => run()),
    ports: {
      platform,
      popup: (template: MenuItemConstructorOptions[], point: { x: number; y: number }, closed: () => void) => Object.assign(shown, { template, point, closed }),
      schedule: (run: () => void) => { pending.push(run); },
    },
  };
}

const ENTRIES = decodeNativeMenu("test", [
  { type: "heading", label: "Thread" },
  { type: "item", id: "pin", label: "Pin thread", checked: true },
  { type: "separator" },
  { type: "item", id: "snooze", label: "Snooze", submenu: [{ type: "item", id: "snooze:1h", label: "For an hour" }] },
  { type: "item", id: "delete", label: "Delete", enabled: false },
]);

describe("the window's context menu", () => {
  it("builds the native template and answers the item clicked, even when the close is reported first", async () => {
    const popup = fakePopup();
    const answer = showWindowContextMenu(popup.ports, ENTRIES, { x: 5, y: 6 });
    const template = popup.shown.template!;
    expect(template.map((item) => item.type ?? "normal")).toEqual(["header", "checkbox", "separator", "normal", "normal"]);
    expect(template[4]!.enabled).toBe(false);
    expect(popup.shown.point).toEqual({ x: 5, y: 6 });

    popup.shown.closed!();
    (template[3]!.submenu as MenuItemConstructorOptions[])[0]!.click!(undefined as never, undefined, undefined as never);
    popup.flush();
    await expect(answer).resolves.toBe("snooze:1h");
  });

  it("answers nothing when the menu closed without a choice", async () => {
    const popup = fakePopup("linux");
    const answer = showWindowContextMenu(popup.ports, ENTRIES, { x: 0, y: 0 });
    // No native header outside macOS: a disabled line.
    expect(popup.shown.template![0]).toEqual({ label: "Thread", enabled: false });
    popup.shown.closed!();
    popup.flush();
    await expect(answer).resolves.toBeUndefined();
  });

  it("refuses a menu that is not one", () => {
    expect(() => decodeNativeMenu("context-menu", [{ type: "item", label: "No id" }])).toThrow(/needs an id/u);
    expect(() => decodeNativeMenu("context-menu", "pin")).toThrow(/list/u);
  });
});
