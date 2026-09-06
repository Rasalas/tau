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
export { ChangesTree, ReviewMode } from "./extension-components";
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
/** The vocabulary of changes and diffs the document surfaces above speak. */
export type {
  ChangeStatus,
  DiffLoadOptions,
  UiChangedFile,
  UiDiffHunk,
  UiDiffLine,
  UiEditor,
  UiFileDiff,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
  WorkspaceDiffScope,
} from "../shared/workspace-kit-types";
export type * from "../shared/contracts";
