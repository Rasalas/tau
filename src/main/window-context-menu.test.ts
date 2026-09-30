import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { decodeNativeMenu } from "../shared/context-menu.js";
import { acceleratorOf, showWindowContextMenu } from "./window-context-menu.js";

function fakePopup(platform: NodeJS.Platform = "darwin", icon?: (name: string) => never) {
  const shown: { template?: MenuItemConstructorOptions[]; point?: { x: number; y: number }; closed?: () => void } = {};
  const pending: Array<() => void> = [];
  return {
    shown,
    flush: () => pending.splice(0).forEach((run) => run()),
    ports: {
      platform,
      popup: (template: MenuItemConstructorOptions[], point: { x: number; y: number }, closed: () => void) => Object.assign(shown, { template, point, closed }),
      schedule: (run: () => void) => { pending.push(run); },
      ...(icon ? { icon } : {}),
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

  it("gives items their icon and shows a chord as the accelerator, any other hint beneath the label", () => {
    const popup = fakePopup("darwin", (name) => (name === "Trash2" ? `image:${name}` : undefined) as never);
    void showWindowContextMenu(popup.ports, decodeNativeMenu("test", [
      { type: "item", id: "settle", label: "Settle thread", icon: "Check", hint: "⌘⇧S" },
      { type: "item", id: "later", label: "Later today", hint: "18:00" },
      { type: "item", id: "copy", label: "Copy", icon: "Trash2", submenu: [{ type: "item", id: "path", label: "Path", icon: "Trash2" }] },
    ]), { x: 0, y: 0 });
    const [settle, later, copy] = popup.shown.template!;
    expect(settle).toMatchObject({ accelerator: "Shift+Cmd+S", registerAccelerator: false });
    expect(settle!.icon).toBeUndefined();
    expect(later).toMatchObject({ sublabel: "18:00" });
    expect(later!.accelerator).toBeUndefined();
    expect(copy!.icon).toBe("image:Trash2");
    expect((copy!.submenu as MenuItemConstructorOptions[])[0]!.icon).toBe("image:Trash2");
  });

  it("reads the page's chord labels as accelerators", () => {
    expect(acceleratorOf("⌘K", "darwin")).toBe("Cmd+K");
    expect(acceleratorOf("⇧⌘S", "darwin")).toBe("Shift+Cmd+S");
    expect(acceleratorOf("⌃⌥⇧⌘]", "darwin")).toBe("Ctrl+Alt+Shift+Cmd+]");
    expect(acceleratorOf("⌘↵", "darwin")).toBe("Cmd+Enter");
    expect(acceleratorOf("⌥↓", "darwin")).toBe("Alt+Down");
    expect(acceleratorOf("Esc", "darwin")).toBe("Escape");
    expect(acceleratorOf("Ctrl+Shift+S", "win32")).toBe("Ctrl+Shift+S");
    expect(acceleratorOf("Ctrl++", "linux")).toBe("Ctrl+Plus");
    expect(acceleratorOf("Win+Alt+F5", "linux")).toBe("Super+Alt+F5");
    expect(acceleratorOf("Tomorrow, 9:00", "darwin")).toBeUndefined();
    expect(acceleratorOf("Mon 9:00", "win32")).toBeUndefined();
    expect(acceleratorOf("Meta+S", "linux")).toBeUndefined();
  });

  it("refuses a menu that is not one", () => {
    expect(() => decodeNativeMenu("context-menu", [{ type: "item", label: "No id" }])).toThrow(/needs an id/u);
    expect(() => decodeNativeMenu("context-menu", "pin")).toThrow(/list/u);
    // An icon is a component name, nothing else; a hint is short.
    expect(decodeNativeMenu("context-menu", [{ type: "item", id: "a", label: "A", icon: "../x", hint: "x".repeat(61) }])).toEqual([{ type: "item", id: "a", label: "A" }]);
  });
});
