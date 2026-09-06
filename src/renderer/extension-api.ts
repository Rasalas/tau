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
// The placement seam of ADR 0012: a kit that has the host draw a native view
// over its panel publishes that rectangle, and core's own floats keep clear of it.
export { reserveRegion, reservedRegion, type ReservedRegion } from "./reserved-region";
export { formatCost } from "./cost-format";
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
  ThreadLineage,
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
export type * from "../shared/contracts";
