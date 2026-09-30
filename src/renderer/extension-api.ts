/**
 * The `tau` module a runtime desktop extension imports. It is the same surface
 * the bundled extensions use, published to extension code through
 * `globalThis.__tauShared` rather than bundled twice.
 */
export {
  useWorkbench,
  useWorkbenchShell,
  useObservatory,
  useThreadStore,
} from "./workbench-context";
export { HostUnavailableError } from "./extension-system";
export { errorMessage } from "../workbench/error-message";
// The placement seam of ADR 0012: a kit that has the host draw a native view
// over its panel publishes that rectangle, and core's own floats keep clear of it.
export { reserveRegion, reservedRegion, type ReservedRegion } from "./reserved-region";
export type { MenuItem, MenuSection } from "./components/Menu";
// Components drawn after a user action are deferred: each loads in its own chunk (./deferred-surfaces).
export { ExtensionPromptFrame, OptionRow } from "./deferred-surfaces";
export { PromptSubmitContext, usePromptSubmit } from "./components/prompt-submit";
// The entries of the composer's "…" menu, for a `placement: "menu"` control (API 1.27.0).
export { ComposerMenuItem, ComposerMenuSection } from "./deferred-surfaces";
export type { PromptSubmitAction } from "./components/prompt-submit";
export {
  choiceOptions,
  freeTextOption,
  optionForLabel,
  splitInputTitle,
  splitOption,
  splitPromptTitle,
} from "../shared/extension-prompt-options";
export type { OptionParts, OptionPreview } from "../shared/extension-prompt-options";
export { DiffView, ReviewMode } from "./extension-components";
export { ChangesTree } from "./deferred-surfaces";
// A text file with line numbers and highlighting, as a file tab shows it (API 1.20.0).
export { FileSource } from "./deferred-surfaces";
export { useAppUpdate, usePreferences } from "./renderer-services-context";
export type { AppUpdate } from "./app-update";
// The rows a Settings page is built from, and one config key read across the levels.
export { SettingRow, SettingsSection } from "./deferred-surfaces";
// A page's action at the right of its head (API 1.26.0).
export { SettingsPageAction } from "./settings/page-action";
// The controls of a Settings page (API 1.18.0): the same set core's pages use.
export { Badge, Button, DangerAction, DangerZone, HelpTip, ListField, NumberField, SegmentedControl, Select, SettingsState, Slider, Switch, TextField, ValueList } from "./deferred-surfaces";
export type { ChoiceOption, FieldWidth, SelectOption, ValueListItem } from "./settings/controls";
export type { SettingsNavGroup } from "./settings/settings-nav";
export { useSetting } from "./settings/setting-state";
export type { SettingHandle, SettingOptions } from "./settings/setting-state";
export type { ConfigLayerName, SettingScope } from "../shared/config-layers";
// Read only: preferences sync them from the host, and emit when they do.
export { listUserThemes as userThemes } from "./theme";
export { useClientStorage } from "./client-storage-context";
// The app page on screen, for a sidebar that marks it and offers Back.
export { useOpenPage } from "./app-page-context";
export { getClientStorage } from "../workbench/client-storage";
export { useHostCapabilities, useHostName, hostHasLocalFiles, hostIsReadOnly, READ_ONLY_REASON, useCommandAllowed, hostCommandAllowed } from "./use-host-capabilities";
export { hostAvailable } from "./host-client-context";
// Whether a package's own host half runs, and why not, to disable what calls it (K112).
export { hostAvailability, useHostAvailability, type HostAvailability } from "./use-host-availability";
export { useKeepClear } from "./reserved-region";
export { changesSinceTurn, changesTouchedByTools, readCachedTurnActivity } from "../workbench/turn-activity";
export { formatCost, threadCostLabel, threadCostOrigin } from "./cost-format";
// Presentation core owns and an extension may reuse: the list primitives, the
// menu, the file glyphs, the thread row (it draws provider icons from core's
// asset pipeline, which an esbuild-bundled package has no loader for) and the
// paging state machine behind every changed-file list.
export { VirtualList } from "./components/VirtualList";
export { Menu } from "./deferred-surfaces";
// The UI primitives core draws with (API 1.11.0): tooltips through one layer,
// right-click menus the OS draws where it can, dialogs and popovers that give
// focus back, and the shapes of loading and of nothing to show.
export { Tooltip, tooltipProps, type TooltipOptions } from "./components/ui/Tooltip";
// Paths and branches cut in the middle, not at the end (API 1.11.0).
export { MiddleTruncate, splitMiddle } from "./components/ui/MiddleTruncate";
export { useContextMenu } from "./components/ui/ContextMenu";
export { ConfirmDialog, Dialog, Popover, Sheet } from "./deferred-surfaces";
export { Empty, Skeleton, Spinner } from "./components/ui/Feedback";
export { useFocusReturn, useFocusTrap } from "./components/ui/focus";
export { useEscapeLayer } from "./components/ui/escape-layers";
export type { FloatingAlign, FloatingSide } from "./components/ui/floating";
export type { ToastAction, ToastHandle, ToastOptions, ToastType } from "../workbench/toast-store";
export { FileKindIcon } from "./components/FileKindIcon";
// `projectHue` (API 1.27.0): the hue a row tints a project's tile with, for a tile drawn beside the rows.
export { projectHue, ThreadRow } from "./components/ThreadRow";
// A project's mark, with the picture a kit published (`setProjectIcons`) before the host's (API 1.28.0).
export { ProjectIcon, useProjectIcon, type ProjectIconSubject } from "./components/ProjectIcon";
export { DraftRow, draftTitle } from "./components/DraftRow";
// A runtime's or provider's mark from core's asset pipeline, which a bundled package has no loader for (API 1.15.0).
export { ProviderIconStack, providerHasMark, providerStackLabel } from "./components/ProviderIconStack";
// A thread's model by name, from its runtime's catalog (API 1.23.0).
export { useModelName } from "./use-runtime-catalog";
export { usePagedWorkspaceFiles } from "./components/usePagedWorkspaceFiles";
// Core's own Markdown renderer, and the highlighter behind its code blocks; highlight.js loads on first use.
export { Markdown, canonicalHighlightLanguage, highlightSource, loadHighlightLanguage } from "./components/Markdown";
export type { MarkdownHtml } from "./components/markdown-pipeline";
/** The full-window review surface, as its own chunk: `lazy(() => loadReviewMode().then((ReviewMode) => ({ default: ReviewMode })))`. */
export const loadReviewMode = () => import("./components/ReviewMode").then((module) => module.ReviewMode);
// Runtime instances and version policy (API 1.11.0): the vocabulary, and the
// dialog and banner a backend kit draws, as one chunk loaded on first use.
export {
  DEFAULT_INSTANCE_ID,
  isRuntimeInstanceOf,
  runtimeDriver,
  runtimeInstanceId,
  runtimeInstanceKind,
  type RuntimeInstanceConfig,
} from "../shared/runtime-instances";
export const loadRuntimeInstanceUi = () => import("./components/RuntimeInstanceUi");
export type { RuntimeInstanceDialogProps, RuntimeInstanceSetupProps, RuntimeInstanceView, RuntimeVersionBannerProps } from "./components/RuntimeInstanceUi";
export { compareVersions, updateAvailable } from "../shared/runtime-version";
// A machine's own Tau (K103): its update as its host reports it, and which machines are behind.
export { describeHostUpdate, hostUpdatePending, machineBehind } from "../shared/host-updates";
export type { HostUpdatePhase, HostUpdateStatus } from "../shared/host-updates";
export { useHostUpdate, useMachineUpdates, type MachineUpdate, type MachineUpdates } from "./machine-updates";
// Signing in from a Providers card (API 1.12.0): the vocabulary, and the account rows as one chunk loaded on first use.
export { SIGN_IN_COMMANDS, SIGN_IN_EVENT, signInActive } from "../shared/sign-in";
export type * from "../shared/sign-in";
export const loadSignInUi = () => import("./components/SignInUi");
export type { SignInSetupProps } from "./components/SignInUi";
/** The update toasts a backend kit offers for its program, as their own chunk (API 1.11.0). */
export const loadRuntimeUpdateToasts = () => import("./runtime-update-toasts");
export type { RuntimeUpdateRun, RuntimeUpdateToasts, RuntimeUpdateToastsOptions } from "./runtime-update-toasts";
export type {
  DesktopExtension,
  DesktopExtensionContext,
  HostExtensionClient,
  HostExtensionBridge,
  ExtensionEvent,
  ComposerControlContribution,
  ComposerControlProps,
  ComposerGateContext,
  ComposerGateContribution,
  ComposerGateProps,
  ModelBadgeContribution,
  ComposerChipDetailProps,
  ComposerChipIcon,
  ComposerInlineChip,
  ComposerInlineChips,
  ComposerInlineContext,
  ComposerInlineContribution,
  ComposerInlineProps,
  ComposerKeyEvent,
  ComposerSendContribution,
  ComposerTriggerContribution,
  ComposerTriggerItem,
  TranscriptRow,
  TranscriptRowsHandle,
  LookInRegionContext,
  RegionPlacement,
  RegionProps,
  RegionContribution,
  ThreadListEntry,
  ThreadListPlace,
  ThreadListSource,
  StatusItemContribution,
  ThreadLineage,
  ExtensionProblem,
  OverlayProps,
  OverlayContribution,
  WorkbenchEvent,
  WorkbenchEventType,
  WorkbenchEvents,
  WorkbenchActions,
  RuntimeModels,
  PanelContribution,
  PanelPlacement,
  PanelProps,
  StageTabContribution,
  StageTabHandle,
  SettingsPageContribution,
  SettingsPageProps,
  PageContribution,
  PageSummary,
  PageSummaryProps,
  PageProps,
  SettingsSectionContribution,
  SettingsSectionPage,
  SettingsSectionProps,
  SidebarContribution,
  SidebarContributionProps,
  ProjectSourceContribution,
  ProjectSourceProps,
  CommandContribution,
  CommandSurface,
  CommandContext,
  PaletteItem,
  PaletteMenu,
  PaletteSearchContext,
  PaletteSourceContribution,
  ModelSelectionContribution,
  ThreadMenuContribution,
  ThreadMenuLookup,
  UserKeybinding,
  UserKeymapContribution,
  NewThreadClaimEvent,
  NewThreadPromptEvent,
  NewThreadPromptGate,
  PromptHookContribution,
  MessageActionContribution,
  MessageBlockContribution,
  MessageBlockProps,
  PromptRendererContribution,
  PromptRendererProps,
  PromptSubmittedEvent,
  DocumentOrigin,
  DocumentSourceContribution,
  ToolPresentation,
  ToolCardContribution,
  ToolCardProps,
  ExtensionOption,
} from "./extension-system";
export type {
  WorkbenchContextValue,
  WorkbenchShellContextValue,
  ObservatoryContextValue,
  TimelineEvent,
} from "./workbench-context";
export type { ThreadStore, ThreadStoreSnapshot, ThreadActivitySnapshot } from "../workbench/thread-store";
export type { DraftThread } from "../workbench/draft-threads";
/** The shape of a stage tab, as `actions.stageTabs()` hands it over. */
export type { StageExtensionTab, StageFileTab, StagePanelTab, StageState, StageTab, StageThreadTab, StageView } from "../workbench/stage";
export type { PreferencesStore } from "./preferences";
/** What `context.attention` offers: a system notification and the app icon's badge. */
export type { PlatformAttention, SystemNotification, SystemNotificationOutcome } from "../workbench/platform";
export type { PlatformEnvironments } from "../workbench/environments";
export type {
  EnvironmentAgentsOutcome,
  EnvironmentAgentsResult,
  EnvironmentPairInput,
  EnvironmentPairResult,
  EnvironmentPreferences,
  EnvironmentStatus,
  EnvironmentNewThread,
  EnvironmentTarget,
  UiEnvironment,
  UiEnvironmentPairing,
  UiEnvironmentProject,
  UiEnvironmentThread,
  UiEnvironments,
} from "../shared/environments";
export type { DiscoveredHost, UiDiscoveredHosts } from "../shared/discovery";
/** A machine's load and readiness, as `host-resources` and `readiness` answer them (API 1.15.0). */
export type { HostDisplayKind, HostReadiness, HostResources, RuntimeReadiness, RuntimeReadinessState } from "../shared/host-resources";
/** The hosts one Bonjour search found, with a slot per host for an action (API 1.13.0). */
export { NearbyMachineList } from "./deferred-surfaces";
export type { ClientStorage } from "../workbench/client-storage";
export type { ThreadActivity, ThreadRowMachine } from "./components/ThreadRow";
/** A thread row's state from the thread store's activity, as every client's list shows it (API 1.27.0). */
export { THREAD_QUESTION_LABEL, threadLimitHint, threadRowStatus, type ThreadRowStatus } from "../workbench/thread-row-status";
/** The line seam of `ReviewMode`'s diffs. */
export type { DiffLineContext, DiffLineSlot } from "./components/DiffView";
export type { HostActionResult, NewThreadResult } from "../shared/host-protocol";
export type { WorkspaceRef } from "../shared/workspace-identity";
export type * from "../shared/workspace-kit-types";
// A thread's branch and pull requests, as Workspace Kit and Review Kit provide them (K112).
export { THREAD_BRANCH_SERVICE, THREAD_PULL_REQUESTS_SERVICE } from "../shared/thread-git";
export type { ThreadBranch, ThreadBranchService, ThreadPullRequest, ThreadPullRequestsService } from "../shared/thread-git";
export type * from "../shared/contracts";
