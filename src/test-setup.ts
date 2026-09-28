import { relative } from "node:path";
import { afterAll, afterEach, beforeAll, inject, vi } from "vitest";
import { isolateHome } from "./main/test-support/test-home.js";
import { TEST_FILE_VARIABLE, TEST_RUN_VARIABLE } from "./main/test-support/test-processes.js";

// Each file gets a temporary home, and with it its own ~/.pi/agent, ~/.tau, ~/.codex and the rest;
// a write into the real home's tool folders is refused and fails the file.
const testHome = isolateHome();
afterAll(() => {
  testHome.remove();
  if (testHome.violations.length > 0) throw new Error(`Tests wrote into the real home:\n  ${testHome.violations.join("\n  ")}`);
});

// A host built in a test would otherwise watch the developer's own ~/.tau and
// ~/.pi: real files, real edits, and one more set of handles per suite. A test
// about watching builds its watcher directly.
process.env.TAU_NO_WATCH = "1";
// The Servers kit refuses any target but loopback, as in an isolated instance.
process.env.TAU_SERVERS_LOOPBACK_ONLY = "1";

// Every process a test starts inherits this run's tag; the global teardown
// (src/test-global-setup.ts) fails the run on any that outlive it.
process.env[TEST_RUN_VARIABLE] = inject("tauTestRun");
beforeAll((suite) => {
  if ("filepath" in suite) process.env[TEST_FILE_VARIABLE] = encodeURIComponent(relative(process.cwd(), suite.filepath));
});

// The DOM-only parts load only where there is a DOM: most files run in Node, and
// importing Testing Library and React costs every one of them on a slow runner.
const dom = typeof document !== "undefined";

// TAU_TEST_SLOW_RENDERS=<ms> delays every render React schedules outside act(): React's scheduler
// takes setImmediate when it loads. See "Component tests" in docs/agents/testing-the-app.md.
const slowRenders = Number(process.env.TAU_TEST_SLOW_RENDERS ?? 0);
if (dom && slowRenders > 0) {
  const later = globalThis.setTimeout;
  globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => later(callback, slowRenders, ...args)) as unknown as typeof setImmediate;
}

// The app loads deferred components (src/renderer/deferred-surfaces.ts) when idle;
// a test file's are loaded before its tests run, so they draw synchronously there too.
beforeAll(async () => {
  if (!dom) return;
  const { preloadDeferred } = await import("./renderer/components/deferred");
  await preloadDeferred();
});

// Integration-heavy renderer tests share the machine with Git and runtime
// subprocess fixtures. Keep DOM polling tolerant of scheduler contention while
// preserving each assertion's own failure output.
if (dom) (await import("@testing-library/dom")).configure({ asyncUtilTimeout: 5_000 });
// vi.waitFor gives up after 1 s unless told otherwise, less than a spawn or a socket round trip
// takes on a busy runner. It gets the DOM helpers' budget (expect.poll's is in vitest.config.ts).
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => waitFor(callback, typeof options === "number" ? options : { timeout: 5_000, ...options })) as typeof vi.waitFor;

// Unmount whatever a DOM test rendered even when its file forgot to. A mounted
// tree keeps observers and frame callbacks alive past the test that made them.
afterEach(async () => {
  if (!dom) return;
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
// throws "window is not defined". 200 ms (50 ms of slack over the 150 ms timer)
// lets it lapse before the environment goes. Removing the sleep would require
// the upstream library to cancel the timer on unmount, which it does not.
afterAll(async () => {
  if (!dom) return;
  await new Promise((resolve) => setTimeout(resolve, 200));
});
