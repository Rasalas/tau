// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { RequestRefresh } from "./request-refresh.js";

it("shares one refresh per visible key, pauses hidden reads, and refreshes on return", () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  const shown = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const read = vi.fn();
  const refresh = new RequestRefresh(read);
  const first = refresh.watch("ws-a");
  const second = refresh.watch("ws-a");
  try {
    vi.advanceTimersByTime(60_000);
    expect(read.mock.calls).toEqual([["ws-a"]]);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(180_000);
    window.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(2);
    first();
    vi.advanceTimersByTime(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    second();
    vi.advanceTimersByTime(180_000);
    window.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { first(); second(); refresh.dispose(); shown.mockRestore(); vi.useRealTimers(); }
});
