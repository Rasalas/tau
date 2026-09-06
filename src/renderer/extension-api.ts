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
export { errorMessage } from "./error-message";
export { usePreferences } from "./renderer-services-context";
export { useClientStorage } from "./client-storage-context";
export { getClientStorage } from "./client-storage";
export { useHostCapabilities, hostHasLocalFiles } from "./use-host-capabilities";
export { hostAvailable } from "./host-client-context";
export { useKeepClear } from "./reserved-region";
export { changesSinceTurn, changesTouchedByTools, readCachedTurnActivity } from "./turn-activity";
export { formatCost, threadCostLabel, threadUsageDetail } from "./cost-format";
// Presentation core owns and an extension may reuse: the list primitives, the
// menu, the file glyphs, the thread row (it draws provider icons from core's
// asset pipeline, which an esbuild-bundled package has no loader for) and the
// paging state machine behind every changed-file list.
export { VirtualList } from "./components/VirtualList";
export { Menu } from "./components/Menu";
export { FileKindIcon } from "./components/FileKindIcon";
export { ChangesTree } from "./components/ChangesTree";
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
  TranscriptRow,
  TranscriptRowsHandle,
  RegionPlacement,
  RegionProps,
  RegionContribution,
  StatusItemContribution,
  OverlayProps,
  OverlayContribution,
  WorkbenchEvent,
  WorkbenchEventType,
  WorkbenchEvents,
  WorkbenchActions,
  PanelContribution,
  PanelProps,
  SidebarContribution,
  SidebarContributionProps,
  ProjectSourceContribution,
  ProjectSourceProps,
  CommandContribution,
  CommandSurface,
  PromptHookContribution,
  PromptSubmittedEvent,
  DocumentSourceContribution,
  ThreadLineage,
  ToolPresentation,
  ExtensionOption,
} from "./extension-system";
export type {
  WorkbenchContextValue,
  WorkbenchShellContextValue,
  ObservatoryContextValue,
  TimelineEvent,
} from "./workbench-context";
export type { ThreadStore, ThreadStoreSnapshot, ThreadActivitySnapshot } from "./thread-store";
export type { PreferencesStore } from "./preferences";
export type { ClientStorage } from "./client-storage";
export type { MenuItem } from "./components/Menu";
export type { ThreadActivity } from "./components/ThreadRow";
export type { HostActionResult, NewThreadResult } from "../shared/host-protocol";
export type { WorkspaceRef } from "../shared/workspace-identity";
export type * from "../shared/workspace-kit-types";
export type { TurnCheckpointStatus, UiTurnCheckpoint } from "../shared/turn-checkpoint-types";
export type * from "../shared/contracts";
