import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_WINDOW_IDLE_MS, DisplayWindow } from "./display-window.js";

function control() {
  const log: string[] = [];
  return { log, control: { start: vi.fn(async () => { log.push("start"); }), stop: vi.fn(async () => { log.push("stop"); }) } };
}

describe("the window on the invisible display", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts once for calls that arrive together", async () => {
    const { control: window, log } = control();
    const display = new DisplayWindow(window);
    await Promise.all([display.ensure(), display.ensure()]);
    expect(log).toEqual(["start"]);
    display.dispose();
  });

  it("stops after ten minutes without a call, and a call in between postpones it", async () => {
    const { control: window, log } = control();
    const display = new DisplayWindow(window);
    await display.ensure();

    await vi.advanceTimersByTimeAsync(DISPLAY_WINDOW_IDLE_MS - 60_000);
    display.activity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toEqual(["start"]);

    await vi.advanceTimersByTimeAsync(DISPLAY_WINDOW_IDLE_MS - 60_000);
    expect(log).toEqual(["start", "stop"]);

    // The next call starts it again, and the clock starts over.
    await display.ensure();
    await vi.advanceTimersByTimeAsync(DISPLAY_WINDOW_IDLE_MS);
    expect(log).toEqual(["start", "stop", "start", "stop"]);
  });

  it("passes on a start that failed, and tries again on the next call", async () => {
    const { control: window } = control();
    window.start.mockRejectedValueOnce(new Error("unit not found"));
    const display = new DisplayWindow(window);
    await expect(display.ensure()).rejects.toThrow(/unit not found/u);
    await expect(display.ensure()).resolves.toBeUndefined();
    expect(window.start).toHaveBeenCalledTimes(2);
    display.dispose();
  });
});
