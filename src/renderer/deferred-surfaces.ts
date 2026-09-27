import { deferred, deferredModule, preloadDeferredWhenIdle } from "./components/deferred";

/*
 * Surfaces drawn only after a user action, and code only a user action runs,
 * each in a chunk of its own and preloaded once the window is idle
 * (docs/PERFORMANCE.md, "Initial script headroom"). Import these names
 * instead of the modules behind them; `deferred-surfaces.test.ts` fails when
 * the start-up graph reaches one of those.
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
export const FileSource = deferred(() => import("./components/FileSource").then((module) => module.FileSource));
export const ChangesTree = deferred(() => import("./components/ChangesTree").then((module) => module.ChangesTree));
export const Dialog = deferred(() => import("./components/ui/Dialog").then((module) => module.Dialog));
export const Popover = deferred(() => import("./components/ui/Dialog").then((module) => module.Popover));
export const Sheet = deferred(() => import("./touch/Sheet").then((module) => module.Sheet));
export const ConfirmDialog = deferred(() => import("./components/ui/ConfirmDialog").then((module) => module.ConfirmDialog));
export const SettingRow = deferred(() => import("./settings/settings-layout").then((module) => module.SettingRow));
export const SettingsSection = deferred(() => import("./settings/settings-layout").then((module) => module.SettingsSection));
// The controls those rows hold (API 1.18.0); one chunk with the rows.
const controls = () => import("./settings/controls");
export const Switch = deferred(() => controls().then((module) => module.Switch));
export const SegmentedControl = deferred(() => controls().then((module) => module.SegmentedControl));
export const Select = deferred(() => controls().then((module) => module.Select));
export const NumberField = deferred(() => controls().then((module) => module.NumberField));
export const TextField = deferred(() => controls().then((module) => module.TextField));
export const ListField = deferred(() => controls().then((module) => module.ListField));
export const ValueList = deferred(() => controls().then((module) => module.ValueList));
export const Badge = deferred(() => controls().then((module) => module.Badge));
export const HelpTip = deferred(() => controls().then((module) => module.HelpTip));
export const Button = deferred(() => controls().then((module) => module.Button));
export const DangerZone = deferred(() => controls().then((module) => module.DangerZone));
export const DangerAction = deferred(() => controls().then((module) => module.DangerAction));
export const SettingsState = deferred(() => controls().then((module) => module.SettingsState));
export const Slider = deferred(() => controls().then((module) => module.Slider));
export const ReloadCurtain = deferred(() => import("./components/ReloadCurtain").then((module) => module.ReloadCurtain));
// Mounted at start-up, but its first look at pairing requests is 1.5 s later.
export const PairingRequestWatcher = deferred(() => import("./pairing/PairingRequestWatcher").then((module) => module.PairingRequestWatcher));
export const NearbyMachineList = deferred(() => import("./settings/NearbyMachineList").then((module) => module.NearbyMachineList));

// Code behind a user action rather than a surface.
export const loadSubmissionController = deferredModule(() => import("./submission-controller"));
export const loadRuntimeControlRuns = deferredModule(() => import("./settings/runtime-control-runs"));
export const loadFileMentions = deferredModule(() => import("./file-mention-expander"));
export const loadVimNormalKeys = deferredModule(() => import("./components/composer-vim-normal"));

// No top-level await here: Rollup would split the start-up graph into many chunks. Tests preload in src/test-setup.ts.
if (import.meta.env.PROD) preloadDeferredWhenIdle();
