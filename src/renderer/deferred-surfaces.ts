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
export const ExtensionPrompt = deferred(() => import("./components/ExtensionPrompt").then((module) => module.ExtensionPrompt));
export const ExtensionPromptFrame = deferred(() => import("./components/ExtensionPrompt").then((module) => module.ExtensionPromptFrame));
export const OptionRow = deferred(() => import("./components/ExtensionPrompt").then((module) => module.OptionRow));
export const AttachmentLightbox = deferred(() => import("./components/AttachmentLightbox").then((module) => module.AttachmentLightbox));
export const ChangesTree = deferred(() => import("./components/ChangesTree").then((module) => module.ChangesTree));
export const Dialog = deferred(() => import("./components/ui/Dialog").then((module) => module.Dialog));
export const Popover = deferred(() => import("./components/ui/Dialog").then((module) => module.Popover));
export const ConfirmDialog = deferred(() => import("./components/ui/ConfirmDialog").then((module) => module.ConfirmDialog));
export const SettingRow = deferred(() => import("./settings/settings-layout").then((module) => module.SettingRow));
export const SettingsSection = deferred(() => import("./settings/settings-layout").then((module) => module.SettingsSection));

// No top-level await here: Rollup would split the start-up graph into many chunks. Tests preload in src/test-setup.ts.
if (import.meta.env.PROD) preloadDeferredWhenIdle();
