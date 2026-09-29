// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("Popover placed against another element", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  function FrameHarness() {
    const chip = useRef<HTMLButtonElement>(null);
    const frame = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    return <>
      <div ref={frame} data-testid="frame"><button type="button" ref={chip} onClick={() => setOpen(true)}>Model</button></div>
      {open ? <Popover anchor={chip} placeAgainst={frame} side="top" label="Pick" onClose={() => setOpen(false)}>list</Popover> : null}
    </>;
  }

  it("opens 6 px above the frame's top at its left edge, not at the control that opened it", () => {
    render(<FrameHarness />);
    screen.getByTestId("frame").getBoundingClientRect = () => rect(260, 600, 360, 110);
    screen.getByRole("button", { name: "Model" }).getBoundingClientRect = () => rect(268, 660, 120, 28);
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute("role") === "dialog" ? rect(0, 0, 460, 300) : original.call(this);
    };
    try {
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      const popover = screen.getByRole("dialog", { name: "Pick" });
      expect(popover.style.left).toBe("260px");
      expect(popover.style.top).toBe(`${600 - 6 - 300}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
