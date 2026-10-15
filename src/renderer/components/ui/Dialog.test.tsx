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

describe("Dialog Tab order", () => {
  it("wraps Tab at the last control Tab can reach, not at one only a script focuses", () => {
    render(<Dialog label="Pick" onClose={() => undefined}>
      <input aria-label="Filter" />
      <button type="button">Last stop</button>
      <button type="button" tabIndex={-1}>Script only</button>
    </Dialog>);
    const last = screen.getByRole("button", { name: "Last stop" });
    act(() => { last.focus(); });
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Filter" }));
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
    const observers: FakeResizeObserver[] = [];
    class FakeResizeObserver implements ResizeObserver {
      constructor(readonly notify: ResizeObserverCallback) { observers.push(this); }
      observe = vi.fn<ResizeObserver["observe"]>();
      unobserve = vi.fn<ResizeObserver["unobserve"]>();
      disconnect = vi.fn<ResizeObserver["disconnect"]>();
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const anchorRect = { x: 600, y: 270, left: 600, top: 270, right: 640, bottom: 298, width: 40, height: 28, toJSON() {} };
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(anchorRect);
    vi.stubGlobal("innerWidth", 850);
    vi.stubGlobal("innerHeight", 500);
    try {
      render(<PopoverHarness />);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const popup = screen.getByRole("dialog", { name: "Details" });
      const anchor = screen.getByRole("button", { name: "Details" });
      const observer = observers.filter((candidate) => candidate.observe.mock.calls.some(([target]) => target === popup)).at(-1)!;
      expect(observer).toBeDefined();
      expect(popup.style.top).toBe("304px");
      let height = 322;
      // An instance spy would reuse the inherited prototype mock in Vitest 4.
      bounds.mockImplementation(function (this: HTMLElement) {
        return this === popup ? { x: 0, y: 0, left: 0, top: 0, right: 320, bottom: height, width: 320, height, toJSON() {} } : anchorRect;
      });
      act(() => { observer.notify([], observer); });
      expect(anchor.getBoundingClientRect()).toEqual(anchorRect);
      expect(popup.dataset.side).toBe("top");
      expect(Number.parseFloat(popup.style.top) + height).toBeLessThanOrEqual(492);
      expect(Number.parseFloat(popup.style.left) + 320).toBeLessThanOrEqual(842);
      const position = popup.style.cssText;
      act(() => { observer.notify([], observer); });
      expect(popup.style.cssText).toBe(position);
      height = 50;
      act(() => { observer.notify([], observer); });
      expect(popup.dataset.side).toBe("bottom");
      expect(popup.style.top).toBe("304px");
      expect(observer.observe).toHaveBeenCalledWith(popup);
      expect(observer.observe).toHaveBeenCalledWith(anchor);
      cleanup();
      expect(observer.disconnect).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      bounds.mockRestore();
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

describe("Popover focus", () => {
  it("takes focus on its first control when a key opened it, and hands it back on Escape", () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Details" });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }));
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("takes focus on itself when a press opened it, so a screen reader and Tab continue inside", () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Details" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Details" }));
  });

  it("leaves focus alone for a hover card that asks not to take it", () => {
    function Card() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" ref={anchor} onClick={() => setOpen(true)}>Badge</button>
        {open ? <Popover anchor={anchor} label="Preview" takeFocus={false} onClose={() => setOpen(false)}><a href="#next">Next</a></Popover> : null}
      </>;
    }
    render(<Card />);
    const trigger = screen.getByRole("button", { name: "Badge" });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Preview" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus where a control inside already took it", () => {
    function Field() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" ref={anchor} onClick={() => setOpen(true)}>Rename</button>
        {open ? <Popover anchor={anchor} label="Rename" onClose={() => setOpen(false)}><input aria-label="Name" autoFocus /><button type="button">Save</button></Popover> : null}
      </>;
    }
    render(<Field />);
    const trigger = screen.getByRole("button", { name: "Rename" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
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
  it("opens a destructive question on Cancel and returns focus after keyboard cancellation", () => {
    const onConfirm = vi.fn();
    function DeleteHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Delete archived thread</button>
        {open ? <ConfirmDialog title="Delete thread for good?" confirmLabel="Delete for good" destructive dontAskAgain
          onConfirm={onConfirm} onCancel={() => setOpen(false)} /> : null}
      </>;
    }
    render(<DeleteHarness />);
    const trigger = screen.getByRole("button", { name: "Delete archived thread" });
    act(() => { trigger.focus(); });
    fireEvent.keyDown(trigger, { key: "Enter" });
    // jsdom does not implement a button's native Enter activation.
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.click(document.activeElement!);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps ordinary confirmations on their action and lets a destructive action be chosen explicitly", () => {
    const onConfirm = vi.fn();
    const view = render(<ConfirmDialog title="Continue?" confirmLabel="Continue" onConfirm={onConfirm} onCancel={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(document.activeElement!);
    expect(onConfirm).toHaveBeenCalledWith(false);
    view.unmount();
    onConfirm.mockClear();
    render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" destructive onConfirm={onConfirm} onCancel={() => undefined} />);
    const action = screen.getByRole("button", { name: "Delete" });
    act(() => { action.focus(); });
    fireEvent.keyDown(action, { key: "Enter" });
    fireEvent.click(action);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("focuses typed confirmation and keeps Enter locked until the requested text matches", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Delete it?" confirmText="thread" confirmLabel="Delete" destructive onConfirm={onConfirm} onCancel={() => undefined} />);
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "thread" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("does not confirm typed text on IME Enter (%j)", (composition) => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Delete it?" confirmText="日本語" confirmLabel="Delete" onConfirm={onConfirm} onCancel={() => undefined} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "日本語" } });
    const allowed = fireEvent.keyDown(input, { key: "Enter", ...composition });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(allowed).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("draws the action's icon before its label, as the design's Delete", () => {
    render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" destructive icon={<svg data-testid="trash" />} onConfirm={() => undefined} onCancel={() => undefined} />);
    const action = screen.getByRole("button", { name: "Delete" });
    expect(action.className).toBe("danger");
    expect(action.firstElementChild?.getAttribute("data-testid")).toBe("trash");
    expect(screen.getByRole("dialog").className).toBe("confirm-dialog");
  });
});
