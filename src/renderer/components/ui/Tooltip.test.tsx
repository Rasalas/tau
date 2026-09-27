// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerEvents } from "../../test-support/pointer-events";
import { Tooltip, TooltipLayer, TOOLTIP_DELAY_MS, TOOLTIP_GROUP_MS, TOOLTIP_LONG_PRESS_MS, tooltipProps } from "./Tooltip";

beforeEach(() => { installPointerEvents(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderToolbar() {
  render(<>
    <TooltipLayer />
    <button type="button" aria-label="Show panel" {...tooltipProps("Show panel", { shortcut: "⌘⌥B" })}>A</button>
    <Tooltip content="Settle thread"><button type="button">B</button></Tooltip>
    <span className="title" {...tooltipProps("A very long thread title", { when: "truncated" })}>A very long…</span>
    <p>elsewhere</p>
  </>);
  return {
    panel: screen.getByRole("button", { name: "Show panel" }),
    settle: screen.getByRole("button", { name: "B" }),
    title: screen.getByText("A very long…"),
    elsewhere: screen.getByText("elsewhere"),
  };
}

const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("TooltipLayer", () => {
  it("opens after the pointer rests on a trigger and names its shortcut", () => {
    const { panel } = renderToolbar();
    fireEvent.pointerOver(panel);
    wait(TOOLTIP_DELAY_MS - 1);
    expect(screen.queryByRole("tooltip")).toBeNull();
    wait(1);
    expect(screen.getByRole("tooltip").textContent).toBe("Show panel⌘⌥B");
    // Its text is the trigger's own name already, so it does not describe it twice.
    expect(panel.hasAttribute("aria-describedby")).toBe(false);
  });

  it("opens the next one at once while the group is warm, and waits again once it cooled", () => {
    const { panel, settle, elsewhere } = renderToolbar();
    fireEvent.pointerOver(panel);
    wait(TOOLTIP_DELAY_MS);
    fireEvent.pointerOut(panel);
    fireEvent.pointerOver(settle);
    expect(screen.getByRole("tooltip").textContent).toBe("Settle thread");
    expect(settle.getAttribute("aria-describedby")).toBe("tau-tooltip");

    fireEvent.pointerOut(settle);
    fireEvent.pointerOver(elsewhere);
    wait(TOOLTIP_GROUP_MS + 1);
    fireEvent.pointerOver(panel);
    expect(screen.queryByRole("tooltip")).toBeNull();
    wait(TOOLTIP_DELAY_MS);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("follows keyboard focus without a wait and closes on Escape", () => {
    const { settle } = renderToolbar();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => { settle.focus(); });
    expect(screen.getByRole("tooltip").textContent).toBe("Settle thread");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays quiet after a press until the pointer leaves the trigger", () => {
    const { panel } = renderToolbar();
    fireEvent.pointerOver(panel);
    wait(TOOLTIP_DELAY_MS);
    fireEvent.pointerDown(panel);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(panel);
    wait(TOOLTIP_DELAY_MS);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a title only when it is cut off", () => {
    const { title } = renderToolbar();
    fireEvent.pointerOver(title);
    wait(TOOLTIP_DELAY_MS);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOut(title);
    Object.defineProperty(title, "scrollWidth", { value: 300 });
    Object.defineProperty(title, "clientWidth", { value: 120 });
    wait(TOOLTIP_GROUP_MS + 1);
    fireEvent.pointerOver(title);
    wait(TOOLTIP_DELAY_MS);
    expect(screen.getByRole("tooltip").textContent).toBe("A very long thread title");
  });

  it("keeps the line breaks of a details tooltip", () => {
    render(<>
      <TooltipLayer />
      <button type="button" {...tooltipProps("Fix the rail\nworkspace · main", { variant: "lines", side: "right" })}>Row</button>
    </>);
    const row = screen.getByRole("button", { name: "Row" });
    expect(row.dataset.tooltipVariant).toBe("lines");
    fireEvent.pointerOver(row);
    wait(TOOLTIP_DELAY_MS);
    const text = screen.getByRole("tooltip").firstElementChild as HTMLElement;
    expect(text.textContent).toBe("Fix the rail\nworkspace · main");
    expect(text.style.whiteSpace).toBe("pre-line");
  });

  it("shows the label on a long press of a finger, and that press does not click", () => {
    const { panel } = renderToolbar();
    const clicked = vi.fn();
    panel.addEventListener("click", clicked);
    fireEvent.pointerDown(panel, { pointerType: "touch", clientX: 5, clientY: 5 });
    wait(TOOLTIP_LONG_PRESS_MS);
    expect(screen.getByRole("tooltip").textContent).toContain("Show panel");
    fireEvent.pointerUp(panel, { pointerType: "touch" });
    fireEvent.click(panel);
    expect(clicked).not.toHaveBeenCalled();
    // A short tap afterwards is an ordinary click.
    fireEvent.pointerDown(panel, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(panel, { pointerType: "touch" });
    fireEvent.click(panel);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("tells a finger at once why a disabled control does nothing", () => {
    render(<>
      <TooltipLayer />
      <button type="button" disabled {...tooltipProps("Read only: this needs a device with Full access.")}>Merge</button>
      <div data-inert="" {...tooltipProps("Read only: it can see settings")}><div inert><button type="button">Model</button></div></div>
    </>);
    const merge = screen.getByRole("button", { name: "Merge" });
    fireEvent.pointerDown(merge, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(merge, { pointerType: "touch" });
    // A lifted finger leaves the control; the reason stays to be read.
    fireEvent.pointerOut(merge, { pointerType: "touch" });
    expect(screen.getByRole("tooltip").textContent).toContain("Full access");
    fireEvent.pointerDown(screen.getByText("Model").closest("[data-inert]")!, { pointerType: "touch", clientX: 5, clientY: 5 });
    expect(screen.getByRole("tooltip").textContent).toContain("can see settings");
  });

  it("lets a finger that moves scroll instead of labelling", () => {
    const { panel } = renderToolbar();
    fireEvent.pointerDown(panel, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerMove(panel, { pointerType: "touch", clientX: 5, clientY: 40 });
    wait(TOOLTIP_LONG_PRESS_MS);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays inside the window at its right edge, measured afresh when it moves straight from another tooltip", () => {
    // A fixed box with auto width takes its text's width, up to its max-width and the room right of its `left`.
    const width = (tooltip: HTMLElement, left: number) => Math.min((tooltip.textContent ?? "").length * 6, 320, window.innerWidth - left);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("tooltip")) {
        const left = Number.parseFloat(this.style.left || "0");
        return { left, top: 0, width: width(this, left), height: 16, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
      }
      // The actions row ends at the window's right edge; Edit sits left of Fork.
      const right = window.innerWidth - (this.dataset.tooltip?.startsWith("Fork") ? 4 : 90);
      return { left: right - 60, top: 200, width: 60, height: 20, right, bottom: 220, x: 0, y: 0, toJSON: () => ({}) };
    });
    render(<>
      <TooltipLayer />
      <div {...tooltipProps("Fork through this message")}>
        <button type="button" {...tooltipProps("Rewind to before this message and edit it in the composer")}>Edit from here</button>
      </div>
    </>);
    const fits = () => {
      const tooltip = screen.getByRole("tooltip");
      const left = Number.parseFloat(tooltip.style.left);
      return left >= 8 && left + width(tooltip, left) <= window.innerWidth - 8;
    };
    const edit = screen.getByRole("button", { name: "Edit from here" });
    fireEvent.pointerOver(edit.parentElement!);
    wait(TOOLTIP_DELAY_MS);
    expect(fits()).toBe(true);
    // Into a trigger inside the first: the one tooltip box moves without closing in between.
    fireEvent.pointerOver(edit);
    expect(screen.getByRole("tooltip").textContent).toContain("Rewind");
    expect(fits()).toBe(true);
    rect.mockRestore();
  });
});
