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
export { Menu } from "./components/Menu";
export type { MenuItem, MenuSection } from "./components/Menu";
export { ExtensionPromptFrame, OptionRow } from "./components/ExtensionPrompt";
export {
  choiceOptions,
  freeTextOption,
  optionForLabel,
  splitInputTitle,
  splitOption,
  splitPromptTitle,
} from "../shared/extension-prompt-options";
export type { OptionParts, OptionPreview } from "../shared/extension-prompt-options";
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
  PromptRendererContribution,
  PromptRendererProps,
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
