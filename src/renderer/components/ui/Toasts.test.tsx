// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../../workbench/client-storage";
import type { Platform } from "../../../workbench/platform";
import { ThreadViewStore } from "../../../workbench/thread-view-store";
import { ToastStore } from "../../../workbench/toast-store";
import { PlatformProvider } from "../../platform-context";
import { showNoticesAsToasts } from "../../use-workbench-toasts";
import { ToastViewport, layoutToasts, toastSwipeDismisses, type ToastPlacement } from "./Toasts";

afterEach(cleanup);

function setup(writeText = vi.fn(async () => undefined), placement?: ToastPlacement) {
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const store = new ToastStore({ schedule: (run) => { const timer = { run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } });
  const platform: Platform = { clipboard: { writeText }, openExternal: () => undefined, storage: createMemoryStorage(), importModule: async () => ({}) };
  render(<PlatformProvider platform={platform}><ToastViewport store={store} {...(placement ? { placement } : {})} /></PlatformProvider>);
  /** Runs every clock that is still set, as if its time ran out. */
  const expire = () => act(() => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run(); });
  return { store, writeText, expire };
}

describe("ToastViewport", () => {
  it("draws the newest toast first, an error as an alert, with its actions", () => {
    const { store } = setup();
    const undo = vi.fn();
    act(() => {
      store.show({ type: "error", description: "Push failed" });
      store.show({ type: "success", title: "Archived 1 thread", actions: [{ label: "Undo", run: undo }] });
    });
    const toasts = [...document.querySelectorAll(".toast-item")];
    expect(toasts[0]!.textContent).toContain("Archived 1 thread");
    expect(screen.getByRole("alert").textContent).toContain("Push failed");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Archived 1 thread")).toBeNull();
  });

  it("copies what it was given to copy and closes on its own button", async () => {
    const { store, writeText } = setup();
    act(() => { store.show({ type: "error", description: "400 · Missing session", copyText: "400 {\"message\":\"Missing session\"}" }); });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("400 {\"message\":\"Missing session\"}");
    await screen.findByRole("button", { name: "Copied" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(store.getToasts()).toEqual([]);
  });

  it("holds every toast while the pointer or focus is on the stack", () => {
    const { store } = setup();
    act(() => { store.show({ description: "Saved" }); });
    const stack = screen.getByRole("region", { name: "Notifications" });
    fireEvent.pointerEnter(stack);
    expect(store.isHeld()).toBe(true);
    expect(stack.dataset.expanded).toBeDefined();
    fireEvent.pointerLeave(stack);
    expect(store.isHeld()).toBe(false);
    act(() => { screen.getByRole("button", { name: "Dismiss notification" }).focus(); });
    expect(store.isHeld()).toBe(true);
    act(() => { screen.getByRole("button", { name: "Dismiss notification" }).blur(); });
    expect(store.isHeld()).toBe(false);
  });

  it("moves focus into the stack on F6", () => {
    const { store } = setup();
    act(() => { store.show({ description: "Saved" }); });
    fireEvent.keyDown(document, { key: "F6" });
    expect(document.activeElement?.className).toContain("toast-item");
  });
});

describe("ToastViewport on a touch layout", () => {
  it("stacks from the bottom, the newest nearest the thumb and the older ones peeking above it", () => {
    const toasts = [{ id: "new", type: "info" as const }, { id: "old", type: "info" as const }];
    const heights = new Map([["new", 60], ["old", 80]]);
    const collapsed = layoutToasts(toasts, heights, false, "bottom");
    expect(collapsed.height).toBe(68);
    expect(collapsed.items[0]!.style.transform).toContain("translateY(8px) scale(1)");
    // The older one's top edge peeks 8 px above the newest.
    expect(collapsed.items[1]!.style.transform).toMatch(/translateY\(-3(\.0+\d*)?px\) scale\(0\.95\)/u);
    const expanded = layoutToasts(toasts, heights, true, "bottom");
    expect(expanded.height).toBe(148);
    expect(expanded.items.map((item) => item.style.transform)).toEqual([
      "translateX(var(--toast-swipe-x, 0px)) translateY(88px) scale(1)",
      "translateX(var(--toast-swipe-x, 0px)) translateY(0px) scale(1)",
    ]);
    expect(layoutToasts(toasts, heights, true, "top").items[1]!.style.transform).toContain("translateY(68px)");
  });

  it("keeps a toast a sheet is drawn over until it can be seen", () => {
    const { store, expire } = setup(undefined, "bottom");
    act(() => { store.show({ id: "update", title: "Update available" }); });
    const item = document.querySelector<HTMLElement>(".toast-item")!;
    item.getBoundingClientRect = () => ({ left: 0, top: 700, width: 360, height: 80, right: 360, bottom: 780, x: 0, y: 700, toJSON: () => ({}) });
    const sheet = document.createElement("section");
    document.body.append(sheet);
    const elementFromPoint = vi.fn(() => sheet as Element);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
    try {
      expire();
      expect(store.getToasts().map((toast) => toast.id)).toEqual(["update"]);
      elementFromPoint.mockReturnValue(item.querySelector(".toast-body")!);
      expire();
      expect(store.getToasts()).toEqual([]);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
      sheet.remove();
    }
  });

  it("is dismissed by a long or fast sideways swipe, not a short or slow one", () => {
    expect(toastSwipeDismisses(140, 360, 0.1)).toBe(true);
    expect(toastSwipeDismisses(-140, 360, -0.1)).toBe(true);
    expect(toastSwipeDismisses(40, 360, 0.8)).toBe(true);
    expect(toastSwipeDismisses(40, 360, -0.8)).toBe(false);
    expect(toastSwipeDismisses(40, 360, 0.2)).toBe(false);
    expect(toastSwipeDismisses(10, 360, 2)).toBe(false);
  });

  it("slides a toast out under a finger that swipes it sideways", () => {
    vi.useFakeTimers();
    try {
      const { store } = setup(undefined, "bottom");
      act(() => { store.show({ id: "a", title: "Saved", actions: [{ label: "Undo", run: vi.fn() }] }); });
      const item = document.querySelector<HTMLElement>(".toast-item")!;
      Object.defineProperty(item, "offsetWidth", { configurable: true, value: 360 });
      const touch = (type: string, clientX: number, timeStamp: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 700 });
        Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 1 }, isPrimary: { value: true }, timeStamp: { value: timeStamp } });
        fireEvent(item, event);
      };
      touch("pointerdown", 100, 1);
      touch("pointermove", 110, 16);
      touch("pointermove", 180, 32);
      expect(item.style.getPropertyValue("--toast-swipe-x")).toBe("80px");
      expect(store.isHeld()).toBe(true);
      touch("pointermove", 260, 48);
      touch("pointerup", 260, 64);
      expect(store.isHeld()).toBe(false);
      act(() => { vi.advanceTimersByTime(200); });
      expect(store.getToasts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("springs back after a short swipe and keeps the toast", () => {
    const { store } = setup(undefined, "bottom");
    act(() => { store.show({ id: "a", title: "Saved" }); });
    const item = document.querySelector<HTMLElement>(".toast-item")!;
    Object.defineProperty(item, "offsetWidth", { configurable: true, value: 360 });
    const touch = (type: string, clientX: number, timeStamp: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 700 });
      Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 1 }, isPrimary: { value: true }, timeStamp: { value: timeStamp } });
      fireEvent(item, event);
    };
    touch("pointerdown", 100, 1);
    touch("pointermove", 130, 200);
    touch("pointerup", 130, 400);
    expect(item.style.getPropertyValue("--toast-swipe-x")).toBe("0px");
    expect(store.getToasts().map((toast) => toast.id)).toEqual(["a"]);
  });
});

describe("notices as toasts", () => {
  it("turns each notice into a toast, headline to read and the whole text to copy", () => {
    const view = new ThreadViewStore();
    const toasts = new ToastStore({ schedule: () => () => undefined });
    const stop = showNoticesAsToasts(view, toasts);
    const payload = '400: {"type":"MissingSessionID","message":"Request is missing x-session"}';
    view.setNotice(payload, "error");
    expect(toasts.getToasts()).toMatchObject([{ type: "error", description: "400 · Request is missing x-session", copyText: payload }]);
    view.setNotice("Saved.", "info");
    expect(toasts.getToasts()[0]).toMatchObject({ type: "info", description: "Saved." });
    expect(toasts.getToasts()[0]!.copyText).toBeUndefined();
    // The same text again is the same toast, not a second one.
    view.setNotice("Saved.", "info");
    expect(toasts.getToasts()).toHaveLength(2);
    stop();
  });
});

describe("ToastViewport holds", () => {
  it("lets go when the toast under the pointer or with focus is taken away", () => {
    const { store } = setup();
    act(() => { store.show({ id: "a", description: "First" }); store.show({ id: "b", description: "Second" }); });
    const stack = screen.getByRole("region", { name: "Notifications" });
    fireEvent.pointerEnter(stack);
    const dismiss = screen.getAllByRole("button", { name: "Dismiss notification" })[0]!;
    act(() => { dismiss.focus(); });
    expect(store.isHeld()).toBe(true);
    // The click removes the focused toast: no blur, no pointerleave follows.
    fireEvent.click(dismiss);
    expect(store.isHeld()).toBe(true);
    fireEvent.pointerMove(document.body);
    expect(store.isHeld()).toBe(false);
    expect(stack.dataset.expanded).toBeUndefined();
  });
});
