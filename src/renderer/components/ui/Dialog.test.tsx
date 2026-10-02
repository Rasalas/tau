// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("ConfirmDialog (1v)", () => {
  it("draws the action's icon before its label, as the design's Delete", () => {
    render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" destructive icon={<svg data-testid="trash" />} onConfirm={() => undefined} onCancel={() => undefined} />);
    const action = screen.getByRole("button", { name: "Delete" });
    expect(action.className).toBe("danger");
    expect(action.firstElementChild?.getAttribute("data-testid")).toBe("trash");
    expect(screen.getByRole("dialog").className).toBe("confirm-dialog");
  });
});
