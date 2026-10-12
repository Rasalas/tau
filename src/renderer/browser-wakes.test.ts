// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { browserWakeSource } from "./browser-wakes";

afterEach(() => { vi.restoreAllMocks(); });

it("checks the host on a native resume even while the window stays hidden, and unsubscribes", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const listener = vi.fn();
  const powerListeners = new Set<(state: "suspend" | "resume") => void>();
  const stop = browserWakeSource((power) => {
    powerListeners.add(power);
    return () => { powerListeners.delete(power); };
  })(listener);

  document.dispatchEvent(new Event("visibilitychange"));
  expect(listener).not.toHaveBeenCalled();
  for (const power of powerListeners) { power("suspend"); power("resume"); }
  expect(listener.mock.calls).toEqual([["suspend"], ["resume"]]);
  stop();
  expect(powerListeners.size).toBe(0);
  window.dispatchEvent(new Event("online"));
  expect(listener).toHaveBeenCalledTimes(2);
});

it("continues to follow a browser's visibility and network events without a native shell", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const listener = vi.fn();
  const stop = browserWakeSource()(listener);
  document.dispatchEvent(new Event("freeze"));
  document.dispatchEvent(new Event("resume"));
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("offline"));
  expect(listener.mock.calls).toEqual([["suspend"], ["resume"], ["online"], ["offline"]]);
  stop();
});
