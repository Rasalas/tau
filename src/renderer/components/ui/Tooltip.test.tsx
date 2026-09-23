// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipLayer, TOOLTIP_DELAY_MS, TOOLTIP_GROUP_MS, tooltipProps } from "./Tooltip";

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });
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
});
