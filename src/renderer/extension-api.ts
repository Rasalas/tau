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
export { ExtensionPromptFrame, OptionRow, PromptSubmitContext, usePromptSubmit } from "./components/ExtensionPrompt";
export type { PromptSubmitAction } from "./components/ExtensionPrompt";
export {
  choiceOptions,
  freeTextOption,
  optionForLabel,
  splitInputTitle,
  splitOption,
  splitPromptTitle,
} from "../shared/extension-prompt-options";
export type { OptionParts, OptionPreview } from "../shared/extension-prompt-options";
export { ReviewMode } from "./extension-components";
export { ChangesTree } from "./components/ChangesTree";
export { usePreferences } from "./renderer-services-context";
export { useClientStorage } from "./client-storage-context";
export { getClientStorage } from "../workbench/client-storage";
export { useHostCapabilities, hostHasLocalFiles } from "./use-host-capabilities";
export { hostAvailable } from "./host-client-context";
export { useKeepClear } from "./reserved-region";
export { changesSinceTurn, changesTouchedByTools, readCachedTurnActivity } from "../workbench/turn-activity";
export { formatCost } from "./cost-format";
// Presentation core owns and an extension may reuse: the list primitives, the
// menu, the file glyphs, the thread row (it draws provider icons from core's
// asset pipeline, which an esbuild-bundled package has no loader for) and the
// paging state machine behind every changed-file list.
export { VirtualList } from "./components/VirtualList";
export { Menu } from "./components/Menu";
export { FileKindIcon } from "./components/FileKindIcon";
export { ThreadRow } from "./components/ThreadRow";
export { usePagedWorkspaceFiles } from "./components/usePagedWorkspaceFiles";
/** The full-window review surface, as its own chunk: `lazy(() => loadReviewMode().then((ReviewMode) => ({ default: ReviewMode })))`. */
export const loadReviewMode = () => import("./components/ReviewMode").then((module) => module.ReviewMode);
export type {
  DesktopExtension,
  DesktopExtensionContext,
  HostExtensionClient,
  HostExtensionBridge,
  ExtensionEvent,
  ComposerControlContribution,
  ComposerControlProps,
  ComposerInlineContext,
  ComposerInlineContribution,
  ComposerInlineProps,
  ComposerKeyEvent,
  ComposerSendContribution,
  ComposerTriggerContribution,
  ComposerTriggerItem,
  TranscriptRow,
  TranscriptRowsHandle,
  RegionPlacement,
  RegionProps,
  RegionContribution,
  StatusItemContribution,
  ThreadLineage,
  ExtensionProblem,
  OverlayProps,
  OverlayContribution,
  WorkbenchEvent,
  WorkbenchEventType,
  WorkbenchEvents,
  WorkbenchActions,
  PanelContribution,
  PanelProps,
  StageTabContribution,
  StageTabHandle,
  SettingsPageContribution,
  SettingsPageProps,
  SidebarContribution,
  SidebarContributionProps,
  ProjectSourceContribution,
  ProjectSourceProps,
  CommandContribution,
  CommandSurface,
  NewThreadPromptEvent,
  NewThreadPromptGate,
  PromptHookContribution,
  MessageActionContribution,
  PromptRendererContribution,
  PromptRendererProps,
  PromptSubmittedEvent,
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
/** The shape of a stage tab, as `actions.stageTabs()` hands it over. */
export type { StageExtensionTab, StageFileTab, StageState, StageTab, StageThreadTab, StageView } from "../workbench/stage";
export type { PreferencesStore } from "./preferences";
export type { ClientStorage } from "../workbench/client-storage";
export type { ThreadActivity } from "./components/ThreadRow";
export type { HostActionResult, NewThreadResult } from "../shared/host-protocol";
export type { WorkspaceRef } from "../shared/workspace-identity";
export type * from "../shared/workspace-kit-types";
export type * from "../shared/contracts";
