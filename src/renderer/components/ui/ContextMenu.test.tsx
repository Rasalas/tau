// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../../workbench/client-storage";
import type { Platform } from "../../../workbench/platform";
import type { MenuSection } from "../Menu";
import { ContextMenuLayer, nativeMenuEntries, openContextMenu } from "./ContextMenu";

afterEach(cleanup);

const SECTIONS: MenuSection[] = [
  { items: [{ id: "pin", label: "Pin thread", selected: true }] },
  { heading: "Later", items: [{ id: "snooze", label: "Snooze", submenu: [{ items: [{ id: "snooze:1h", label: "For an hour" }] }] }] },
  { items: [{ id: "delete", label: "Delete", destructive: true, disabled: true }] },
];

function platform(contextMenu?: Platform["contextMenu"]): Platform {
  return { clipboard: { writeText: async () => undefined }, openExternal: () => undefined, storage: createMemoryStorage(), importModule: async () => ({}), ...(contextMenu ? { contextMenu } : {}) };
}

describe("context menus", () => {
  it("hands the OS the sections as entries, with separators, headings and submenus", () => {
    expect(nativeMenuEntries(SECTIONS)).toEqual([
      { type: "item", id: "pin", label: "Pin thread", enabled: true, checked: true },
      { type: "separator" },
      { type: "heading", label: "Later" },
      { type: "item", id: "snooze", label: "Snooze", enabled: true, submenu: [{ type: "item", id: "snooze:1h", label: "For an hour", enabled: true }] },
      { type: "separator" },
      { type: "item", id: "delete", label: "Delete", enabled: false },
    ]);
  });

  it("names each item's lucide icon and hands on its hint", () => {
    const [entry] = nativeMenuEntries([{ items: [{ id: "delete", label: "Delete", icon: <Trash2 size={13} />, hint: "⌘⌫" }] }]);
    expect(entry).toEqual({ type: "item", id: "delete", label: "Delete", icon: "Trash2", hint: "⌘⌫", enabled: true });
    // Anything but a lucide icon has no name to give.
    expect(nativeMenuEntries([{ items: [{ id: "x", label: "X", icon: <span /> }] }])[0]).not.toHaveProperty("icon", expect.anything());
  });

  it("answers with what the user chose in the OS's menu, at the pointer", async () => {
    const show = vi.fn(async () => "snooze:1h");
    const preventDefault = vi.fn();
    await expect(openContextMenu(platform({ show }), { clientX: 30, clientY: 40, preventDefault }, SECTIONS)).resolves.toBe("snooze:1h");
    expect(preventDefault).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(nativeMenuEntries(SECTIONS), { x: 30, y: 40 });
  });

  it("draws the page's own menu where the OS draws none or refuses", async () => {
    render(<ContextMenuLayer />);
    const refused = openContextMenu(platform({ show: async () => { throw new Error("unsupported"); } }), { clientX: 10, clientY: 10 }, SECTIONS);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin thread" }));
    await expect(refused).resolves.toBe("pin");

    // The page's menu wears the same icon the OS's would.
    const iconed = openContextMenu(platform(), { clientX: 10, clientY: 10 }, [{ items: [{ id: "delete", label: "Delete", icon: <Trash2 size={13} /> }] }]);
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    expect(item.querySelector("svg.lucide-trash-2")).not.toBeNull();
    fireEvent.click(item);
    await expect(iconed).resolves.toBe("delete");

    const none = openContextMenu(platform(), { clientX: 10, clientY: 10 }, SECTIONS);
    fireEvent.click(await screen.findByRole("button", { name: "Close menu" }));
    await expect(none).resolves.toBeUndefined();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens under the element when the keyboard asked for it", async () => {
    const show = vi.fn(async () => undefined);
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({ left: 100, top: 200, right: 300, bottom: 230, width: 200, height: 30, x: 100, y: 200, toJSON: () => ({}) });
    await openContextMenu(platform({ show }), { clientX: 0, clientY: 0, currentTarget: element }, SECTIONS);
    expect(show).toHaveBeenCalledWith(expect.anything(), { x: 108, y: 230 });
  });
});
