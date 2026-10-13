// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuSection } from "./Menu";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SECTIONS: MenuSection[] = [
  { items: [{ id: "pin", label: "Pin thread" }, { id: "rename", label: "Rename", disabled: true }] },
  {
    items: [{
      id: "snooze",
      label: "Snooze",
      submenu: [{ items: [{ id: "snooze:1h", label: "For an hour" }, { id: "snooze:tomorrow", label: "Until tomorrow" }] }],
    }],
  },
  { items: [{ id: "settle", label: "Settle thread" }, { id: "archive", label: "Archive thread" }, { id: "delete", label: "Delete", destructive: true }] },
];

function Harness({ onSelect }: { onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-anchor">
      <button type="button" aria-haspopup="menu" onClick={() => setOpen(true)}>Thread</button>
      {open ? <Menu sections={SECTIONS} onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** Opens the menu the way a keyboard user does: focus the trigger and press Enter. */
function openWithKeyboard() {
  const onSelect = vi.fn();
  render(<Harness onSelect={onSelect} />);
  const trigger = screen.getByRole("button", { name: "Thread" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(trigger);
  return { onSelect, trigger };
}

const focused = () => (document.activeElement as HTMLElement | null)?.textContent;
const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

describe("Menu", () => {
  it("focuses the first entry when opened from the keyboard and walks with the arrows, Home and End", () => {
    openWithKeyboard();
    expect(focused()).toBe("Pin thread");
    press("ArrowDown");
    // The disabled entry is skipped.
    expect(focused()).toBe("Snooze");
    press("End");
    expect(focused()).toBe("Delete");
    press("ArrowDown");
    expect(focused()).toBe("Pin thread");
    press("ArrowUp");
    expect(focused()).toBe("Delete");
    press("Home");
    expect(focused()).toBe("Pin thread");
  });

  it("jumps by typeahead, a new word after a pause", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    openWithKeyboard();
    press("s");
    press("e");
    expect(focused()).toBe("Settle thread");
    now.mockReturnValue(3_000);
    press("a");
    expect(focused()).toBe("Archive thread");
    now.mockRestore();
  });

  it("opens a submenu with ArrowRight, picks from it, and closes the whole menu", () => {
    const { onSelect, trigger } = openWithKeyboard();
    press("ArrowDown");
    press("ArrowRight");
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    expect(focused()).toBe("For an hour");
    press("ArrowDown");
    fireEvent.click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledWith("snooze:tomorrow");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves a submenu with ArrowLeft, back on the item that opened it", () => {
    openWithKeyboard();
    press("ArrowDown");
    press("ArrowRight");
    press("ArrowLeft");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(focused()).toBe("Snooze");
  });

  it("closes on Escape and on Tab and gives focus back to its trigger", () => {
    const { trigger } = openWithKeyboard();
    press("ArrowDown");
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    press("Tab");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opened by a click, takes focus itself so the arrows work at once", () => {
    render(<Harness onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Thread" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    press("ArrowDown");
    expect(focused()).toBe("Pin thread");
  });

  it("opens at a point over the whole window when asked to", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Menu at={{ x: 40, y: 50 }} sections={SECTIONS} onSelect={onSelect} onClose={onClose} />);
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("at-point");
    fireEvent.click(screen.getByRole("menuitem", { name: "Settle thread" }));
    expect(onSelect).toHaveBeenCalledWith("settle");
    expect(onClose).toHaveBeenCalled();
  });

  it("draws over the window, below its trigger, when a scrolling box would cut it off", () => {
    const rects: Array<[string, DOMRect]> = [["box", new DOMRect(0, 0, 300, 100)], ["menu-anchor", new DOMRect(200, 20, 40, 30)], ["menu", new DOMRect(0, 57, 220, 180)]];
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rects.find(([name]) => this.classList.contains(name))?.[1] ?? new DOMRect();
    });
    render(<div className="box" style={{ overflowY: "auto" }}><Harness onSelect={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("at-point");
    // Right-aligned to the trigger, 7 px under it, as it sits in place.
    expect([menu.style.left, menu.style.top]).toEqual(["20px", "57px"]);
  });

  it("keeps the keyboard on the entries after leaving a box that cut it off", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("box") ? new DOMRect(0, 0, 300, 100) : this.classList.contains("menu") ? new DOMRect(0, 57, 220, 180) : new DOMRect();
    });
    const onSelect = vi.fn();
    render(<div className="box" style={{ overflowY: "auto" }}><Harness onSelect={onSelect} /></div>);
    const trigger = screen.getByRole("button", { name: "Thread" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
    expect(focused()).toBe("Pin thread");
    press("Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("stays in place when the scrolling box has room for it", () => {
    render(<div style={{ overflowY: "auto" }}><Harness onSelect={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    expect(screen.getByRole("menu").parentElement?.className).toBe("menu-anchor");
  });
});

describe("Menu semantics", () => {
  const CHOICES: MenuSection[] = [
    { heading: "Sort", items: [{ id: "recent", label: "Recent", selected: true }, { id: "name", label: "Name", selected: false }] },
    { items: [{ id: "refresh", label: "Refresh" }, { id: "filter", label: "Filter", selected: true, submenu: [{ items: [{ id: "mine", label: "Mine", selected: false }] }] }] },
  ];

  it("reads a choice as a checked or unchecked radio item and a plain entry as an item", () => {
    render(<Menu sections={CHOICES} label="Threads" onSelect={() => undefined} onClose={() => undefined} />);
    const menu = screen.getByRole("menu", { name: "Threads" });
    expect(within(menu).getByRole("menuitemradio", { name: "Recent", checked: true })).toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "Name", checked: false })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Refresh" }).hasAttribute("aria-checked")).toBe(false);
    // An entry that opens a submenu cannot be a radio item.
    expect(within(menu).getByRole("menuitem", { name: "Filter" }).getAttribute("aria-haspopup")).toBe("menu");
    expect(within(screen.getByRole("group", { name: "Sort" })).getAllByRole("menuitemradio")).toHaveLength(2);
  });

  it("reads a choice among several that can all be on as a checkbox item", () => {
    const onSelect = vi.fn();
    render(<Menu
      sections={[{ heading: "Tools", items: [
        { id: "files", label: "Files", selected: true, multiple: true },
        { id: "diffs", label: "Diffs", selected: false, multiple: true },
        { id: "sub", label: "More", selected: true, multiple: true, submenu: [{ items: [{ id: "x", label: "X" }] }] },
        { id: "plain", label: "Plain", multiple: true },
      ] }]}
      label="Tools"
      onSelect={onSelect}
      onClose={() => undefined}
    />);
    const menu = screen.getByRole("menu", { name: "Tools" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Files", checked: true })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Diffs", checked: false })).toBeTruthy();
    expect(within(menu).queryAllByRole("menuitemradio")).toHaveLength(0);
    // `multiple` alone is no choice, and a submenu entry stays an item.
    expect(within(menu).getByRole("menuitem", { name: "Plain" }).hasAttribute("aria-checked")).toBe(false);
    expect(within(menu).getByRole("menuitem", { name: "More" }).getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Diffs" }));
    expect(onSelect).toHaveBeenCalledWith("diffs");
  });

  it("picks a radio item like any other entry", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Menu sections={CHOICES} label="Threads" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(onSelect).toHaveBeenCalledWith("name");
    expect(onClose).toHaveBeenCalled();
  });

  it("starts on the checked item when opened from the keyboard", () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    render(<Menu sections={[{ items: [{ id: "a", label: "A", selected: false }, { id: "b", label: "B", selected: true }] }]} label="Pick" onSelect={() => undefined} onClose={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "B" }));
    trigger.remove();
  });
});
