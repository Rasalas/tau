// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog, Popover } from "./Dialog";

afterEach(cleanup);

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Snooze…</button>
    {open ? <Dialog label="Snooze thread" onClose={() => setOpen(false)}>
      <input aria-label="How long" />
      <button type="button">Cancel</button>
      <button type="button">Snooze</button>
    </Dialog> : null}
  </>;
}

describe("Dialog", () => {
  it("takes focus, keeps Tab inside, and gives focus back on Escape", () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Snooze…" });
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    const field = screen.getByRole("textbox", { name: "How long" });
    expect(document.activeElement).toBe(field);
    act(() => { screen.getByRole("button", { name: "Snooze" }).focus(); });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Snooze");

    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

function PopoverHarness() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" ref={anchor} onClick={() => setOpen(true)}>Details</button>
    <p>outside</p>
    {open ? <Popover anchor={anchor} label="Details" onClose={() => setOpen(false)}><button type="button">Inside</button></Popover> : null}
  </>;
}

describe("Popover", () => {
  it("repositions growing content inside the viewport and disconnects its size observer", () => {
    let notify: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      return { x: 600, y: 270, left: 600, top: 270, right: 640, bottom: 298, width: 40, height: 28, toJSON() {} };
    });
    vi.stubGlobal("innerWidth", 850);
    vi.stubGlobal("innerHeight", 500);
    try {
      render(<PopoverHarness />);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const popup = screen.getByRole("dialog", { name: "Details" });
      expect(popup.style.top).toBe("304px");
      let height = 322;
      vi.spyOn(popup, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: height, width: 320, height, toJSON() {} }));
      act(() => { notify?.([], {} as ResizeObserver); });
      expect(popup.dataset.side).toBe("top");
      expect(Number.parseFloat(popup.style.top) + height).toBeLessThanOrEqual(492);
      expect(Number.parseFloat(popup.style.left) + 320).toBeLessThanOrEqual(842);
      const position = popup.style.cssText;
      act(() => { notify?.([], {} as ResizeObserver); });
      expect(popup.style.cssText).toBe(position);
      height = 50;
      act(() => { notify?.([], {} as ResizeObserver); });
      expect(popup.dataset.side).toBe("bottom");
      expect(observe).toHaveBeenCalledWith(popup);
      expect(observe).toHaveBeenCalledWith(screen.getByRole("button", { name: "Details" }));
      cleanup();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      bounds.mockRestore();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("closes on a press outside, not inside, and returns focus", () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Details" });
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Details" });
    expect(popover.parentElement).toBe(document.body);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }));
    expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

function NestedPopoverHarness() {
  const parent = useRef<HTMLButtonElement>(null);
  const child = useRef<HTMLButtonElement>(null);
  const [parentOpen, setParentOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const [selected, setSelected] = useState(false);
  return <>
    <button ref={parent} onClick={() => setParentOpen(true)}>Project</button>
    <p>Outside nested popovers</p>
    {parentOpen ? <Popover anchor={parent} label="Project" onClose={() => setParentOpen(false)}>
      <button ref={child} onClick={() => setChildOpen(true)}>Branch</button>
      {selected ? <span>Branch selected</span> : null}
      {childOpen ? <Popover anchor={child} label="Branch" onClose={() => setChildOpen(false)}>
        <button onClick={() => { setSelected(true); setChildOpen(false); }}>Choose main</button>
      </Popover> : null}
    </Popover> : null}
  </>;
}

it("keeps a parent popover open while a nested portal is selected and dismisses one layer per outside press", () => {
  render(<NestedPopoverHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Project" }));
  fireEvent.click(screen.getByRole("button", { name: "Branch" }));
  const select = screen.getByRole("button", { name: "Choose main" });
  fireEvent.pointerDown(select);
  fireEvent.click(select);
  expect(screen.getByRole("dialog", { name: "Project" })).toBeTruthy();
  expect(screen.getByText("Branch selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Branch" }));
  fireEvent.pointerDown(screen.getByText("Outside nested popovers"));
  expect(screen.queryByRole("dialog", { name: "Branch" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Project" })).toBeTruthy();
  fireEvent.pointerDown(screen.getByText("Outside nested popovers"));
  expect(screen.queryByRole("dialog", { name: "Project" })).toBeNull();
});

describe("ConfirmDialog (1v)", () => {
  it("draws the action's icon before its label, as the design's Delete", () => {
    render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" destructive icon={<svg data-testid="trash" />} onConfirm={() => undefined} onCancel={() => undefined} />);
    const action = screen.getByRole("button", { name: "Delete" });
    expect(action.className).toBe("danger");
    expect(action.firstElementChild?.getAttribute("data-testid")).toBe("trash");
    expect(screen.getByRole("dialog").className).toBe("confirm-dialog");
  });
});
