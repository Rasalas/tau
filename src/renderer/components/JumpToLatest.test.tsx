// @vitest-environment jsdom
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
