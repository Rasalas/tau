import { configure } from "@testing-library/dom";
import { afterAll, afterEach, vi } from "vitest";

// Integration-heavy renderer tests share the machine with Git and runtime
// subprocess fixtures. Keep DOM polling tolerant of scheduler contention while
// preserving each assertion's own failure output.
configure({ asyncUtilTimeout: 5_000 });

// Unmount whatever a DOM test rendered even when its file forgot to. A mounted
// tree keeps observers and frame callbacks alive past the test that made them.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { act, cleanup } = await import("@testing-library/react");
  cleanup();
  // Virtualized lists remeasure inside a frame callback they never cancel; let
  // that frame run while `window` still exists instead of after teardown.
  if (typeof requestAnimationFrame === "function") {
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
  }
});

// A test that leaves fake timers armed hands them to whatever runs next, which
// is how a suite starts depending on its own order.
afterEach(() => {
  if (!vi.isFakeTimers()) return;
  const pending = vi.getTimerCount();
  vi.useRealTimers();
  if (pending > 0) throw new Error(`Test left ${pending} pending fake timer(s); drain or clear them before it ends.`);
});

// @tanstack/virtual-core resets its scrolling flag on a 150 ms timer it does
// not cancel on unmount; if the file's jsdom is torn down first, that timer
// throws "window is not defined". Let it lapse before the environment goes.
afterAll(async () => {
  if (typeof document === "undefined") return;
  await new Promise((resolve) => setTimeout(resolve, 200));
});
