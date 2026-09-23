// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../../workbench/client-storage";
import type { Platform } from "../../../workbench/platform";
import { ThreadViewStore } from "../../../workbench/thread-view-store";
import { ToastStore } from "../../../workbench/toast-store";
import { PlatformProvider } from "../../platform-context";
import { showNoticesAsToasts } from "../../use-workbench-toasts";
import { ToastViewport } from "./Toasts";

afterEach(cleanup);

function setup(writeText = vi.fn(async () => undefined)) {
  const cancels: Array<() => void> = [];
  const store = new ToastStore({ schedule: () => { const cancel = vi.fn(); cancels.push(cancel); return cancel; } });
  const platform: Platform = { clipboard: { writeText }, openExternal: () => undefined, storage: createMemoryStorage(), importModule: async () => ({}) };
  render(<PlatformProvider platform={platform}><ToastViewport store={store} /></PlatformProvider>);
  return { store, writeText };
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
    fireEvent.focus(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(store.isHeld()).toBe(true);
    fireEvent.blur(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(store.isHeld()).toBe(false);
  });

  it("moves focus into the stack on F6", () => {
    const { store } = setup();
    act(() => { store.show({ description: "Saved" }); });
    fireEvent.keyDown(document, { key: "F6" });
    expect(document.activeElement?.className).toContain("toast-item");
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
