import { deferred, preloadDeferredWhenIdle } from "./components/deferred";

/*
 * Surfaces drawn only after a user action, each in a chunk of its own and
 * preloaded once the window is idle (docs/PERFORMANCE.md, "Initial script
 * headroom"). Import these names instead of the modules behind them;
 * `deferred-surfaces.test.ts` fails when the start-up graph reaches one of those.
 */

export const Menu = deferred(() => import("./components/Menu").then((module) => module.Menu));
export const TranscriptSearch = deferred(() => import("./components/TranscriptSearch").then((module) => module.TranscriptSearch));
export const QueuedMessages = deferred(
  () => import("./components/QueuedMessages").then((module) => module.QueuedMessages),
  ({ queue }) => queue.length > 0,
);

// No top-level await here: Rollup would split the start-up graph into many chunks. Tests preload in src/test-setup.ts.
if (import.meta.env.PROD) preloadDeferredWhenIdle();
