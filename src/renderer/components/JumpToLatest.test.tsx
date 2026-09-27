// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JumpToLatestButton, JumpToLatestStore } from "./JumpToLatest";

afterEach(cleanup);

describe("JumpToLatestStore", () => {
  it("tells its listeners only when the offer changes", () => {
    const store = new JumpToLatestStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const jump = vi.fn();

    store.set(jump);
    store.set(jump);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.available()).toBe(true);

    store.run();
    expect(jump).toHaveBeenCalledOnce();

    store.set(undefined);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.available()).toBe(false);
    store.run();
    expect(jump).toHaveBeenCalledOnce();
  });
});

describe("JumpToLatestButton", () => {
  it("shows only while the transcript offers the jump", () => {
    const store = new JumpToLatestStore();
    render(<JumpToLatestButton store={store} />);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    act(() => store.set(() => undefined));
    const button = screen.getByRole("button", { name: "Jump to latest" });
    expect(button.dataset.tooltip).toBe("Jump to latest");

    act(() => store.set(undefined));
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("sits in a floating slot, and leaves nothing behind at the tail", () => {
    const store = new JumpToLatestStore();
    const view = render(<JumpToLatestButton store={store} />);
    act(() => store.set(() => undefined));
    const slot = screen.getByRole("button", { name: "Jump to latest" }).parentElement!;
    expect(slot.classList.contains("jump-to-latest-float")).toBe(true);

    act(() => store.set(undefined));
    // An empty row is hidden by `:empty`; a leftover slot would keep it.
    expect(view.container.innerHTML).toBe("");
  });

  it("jumps on a click without taking the focus, and hands the focus on after a key press", () => {
    const store = new JumpToLatestStore();
    const jump = vi.fn();
    const onKeyboardJump = vi.fn();
    store.set(jump);
    render(<JumpToLatestButton store={store} onKeyboardJump={onKeyboardJump} />);
    const button = screen.getByRole("button", { name: "Jump to latest" });

    const press = createEvent.pointerDown(button);
    fireEvent(button, press);
    expect(press.defaultPrevented).toBe(true);
    fireEvent.click(button, { detail: 1 });
    expect(jump).toHaveBeenCalledOnce();
    expect(onKeyboardJump).not.toHaveBeenCalled();

    // Enter or Space: a click with no pointer behind it.
    fireEvent.click(button, { detail: 0 });
    expect(jump).toHaveBeenCalledTimes(2);
    expect(onKeyboardJump).toHaveBeenCalledOnce();
  });
});

describe("the floating arrow's styles", () => {
  const BARE = ".region-composer-controls:not(:has(> :not(.jump-to-latest-float)))";
  async function rules() {
    const css = (await readFile(resolve(__dirname, "../styles.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const found: Array<{ selector: string; body: string }> = [];
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      for (const selector of selectors!.split(/,(?![^(]*\))/u)) found.push({ selector: selector.trim(), body: body! });
    }
    return (selector: string) => found.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(";");
  }

  // K42: a row that grew when the arrow came made the transcript 36 px shorter, and its tail jumped.
  it("takes no room beside a pill, so the row keeps its height and the pill its place", async () => {
    const rule = await rules();
    const slot = rule(".jump-to-latest-float");
    expect(slot).toMatch(/width: 0;/u);
    expect(slot).toMatch(/height: 0;/u);
    expect(slot).toMatch(/margin-left: calc\(-1 \* var\(--controls-gap\)\)/u);
    expect(rule(".workbench-region.region-composer-controls")).toMatch(/gap: var\(--controls-gap\)/u);
    expect(rule(".jump-to-latest-float > .jump-to-latest")).toMatch(/position: absolute;/u);
  });

  it("gives a row with only the arrow no height, and floats the arrow over the transcript's edge", async () => {
    const rule = await rules();
    expect(rule(`.workbench-region${BARE}`)).toMatch(/height: 0; padding: 0; margin: 0;/u);
    expect(rule(`${BARE} > .jump-to-latest-float`)).toMatch(/position: absolute;.*bottom: 10px;/u);
  });
});
