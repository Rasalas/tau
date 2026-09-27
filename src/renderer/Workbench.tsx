import { lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folder } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiProject, UiToolOutputPreview, UiToolRun, UiThreadTree } from "../shared/contracts";
import type { UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { StageState } from "../workbench/stage";
import type { StageTabController } from "./stage-tab-controller";
import type { ComposerAttachmentHandle, ComposerControlHandle, SubmitResult } from "./components/Composer";
import { Composer } from "./components/Composer";
import type { ComposerScopeStore } from "../workbench/composer-scope-store";
import type { UiQueuedMessage } from "../shared/contracts";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { ComposerHost, LiveStatus } from "./components/ComposerHost";
import { retryPrompt, TurnErrorLine } from "./components/TurnError";
import { useThreadShell } from "./use-thread-shell";
import { QueuedMessages } from "./deferred-surfaces";
import { ToastLayer } from "./components/ui/ToastLayer";
import { PairingRequestWatcher } from "./pairing/PairingRequestWatcher";
import { TooltipLayer, tooltipProps } from "./components/ui/Tooltip";
import { ContextMenuLayer } from "./components/ui/ContextMenu";
import type { ToastStore } from "../workbench/toast-store";
import { PanelIcon } from "./components/PanelIcon";
import { Region, StatusLine } from "./components/Regions";
import { HostConnectionStatus } from "./host-connection-status";
import { compactFormFor, compactSidebarWidth, rendersOnProfile, type ClientProfile } from "../workbench/client-profile";
import { useClientEnvironment } from "./client-environment";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
import type { ThreadTreeMode } from "./components/ThreadTreeModal";
import { TitleBar } from "./components/TitleBar";
import { ThreadRuntimeBanner } from "./components/ThreadRuntimeBanner";
import { TranscriptHistoryBoundary } from "./components/TranscriptHistoryBoundary";
import { TranscriptViewport } from "./components/TranscriptViewport";
import { useConversationActivities } from "./conversation-activities";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { MountedPanel, PanelMaximizeButton, PanelSlot, usePanelHosts } from "./components/PanelHosts";
import { ResizeHandle } from "./components/ResizeHandle";
import type { PanelLayout } from "./use-panel-layout";
import { panelTabId } from "../workbench/stage";
import { useCenterLayout } from "./use-center-layout";
import {
  DRAWER_DEFAULT_HEIGHT, DRAWER_MIN_HEIGHT, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH,
  drawerMaxHeight, shownDrawerHeight, shownSidebarWidth, sidebarMaxWidth, storedDrawerHeight, storedSidebarWidth,
} from "../workbench/layout-sizes";
import { useClientStorage } from "./client-storage-context";
import type { ClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { usePreferences } from "./renderer-services-context";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { lastUsedProject } from "../workbench/new-thread-project";
import { useHostCapabilities } from "./use-host-capabilities";
import { usePlatform } from "./platform-context";
import type { PreferencesState } from "./preferences";
import type { ThreadStore } from "../workbench/thread-store";
import type { AppPageStore } from "../workbench/app-page-store";
import { AppPageContext } from "./app-page-context";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import { contextBreakdownFor, conversationMessagesFor, toolOutputKiloTokens } from "../workbench/app-state";
import type { TranscriptHistoryController } from "../workbench/transcript-history";
import type { useThreadDropController } from "./use-thread-drop-controller";
import {
  ObservatoryContext,
  ThreadStoreContext,
  WorkbenchContext,
  WorkbenchShellContext,
  type ObservatoryContextValue,
  type WorkbenchContextValue,
  type WorkbenchShellContextValue,
} from "./workbench-context";
import { displayPath } from "./path-display";
import { THREAD_DROP_FEEDBACK } from "../shared/thread-drop";

const DEFAULT_DOCK_WIDTH = 320;
const MIN_DOCK_WIDTH = 220;
const MAX_DOCK_WIDTH = 560;
const DOCK_WIDTH_KEY = STORAGE_KEYS.dockWidth;

function clampDockWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, width))
    : DEFAULT_DOCK_WIDTH;
}

function storedDockWidth(storage: ClientStorage): number {
  const width = Number(storage.get(DOCK_WIDTH_KEY));
  return Number.isFinite(width) && width > 0 ? clampDockWidth(width) : DEFAULT_DOCK_WIDTH;
}
const LazyCommandPalette = lazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const LazyLimitNotice = lazy(() => import("./components/LimitNotice").then(({ LimitNotice }) => ({ default: LimitNotice })));
const LazyStage = lazy(() => import("./components/Stage").then(({ Stage }) => ({ default: Stage })));
const LazyAppPageScreen = lazy(() => import("./pages/AppPageScreen").then(({ AppPageScreen }) => ({ default: AppPageScreen })));
const LazySettingsScreen = lazy(() => import("./settings/SettingsScreen").then(({ SettingsScreen }) => ({ default: SettingsScreen })));
// Modals a command opens; they stay out of the first paint.
const LazyThreadTreeModal = lazy(() => import("./components/ThreadTreeModal").then(({ ThreadTreeModal }) => ({ default: ThreadTreeModal })));
const LazyProjectSourcesModal = lazy(() => import("./components/ProjectSources").then(({ ProjectSourcesModal }) => ({ default: ProjectSourcesModal })));
const LazySystemPromptModal = lazy(() => import("./components/SystemPromptModal").then(({ SystemPromptModal }) => ({ default: SystemPromptModal })));
// The touch layout's own pieces: none of them is in a desktop window's first paint.
const LazyTouchLayer = lazy(() => import("./touch/TouchLayer").then(({ TouchLayer }) => ({ default: TouchLayer })));
const LazyTouchThreadBrowser = lazy(() => import("./touch/TouchThreadBrowser").then(({ TouchThreadBrowser }) => ({ default: TouchThreadBrowser })));
const LazyPanelSheet = lazy(() => import("./touch/PanelSheet").then(({ PanelSheet }) => ({ default: PanelSheet })));
// Mounted closed from the start, like the palette, so its chunk is in before the first open.
const LazyProjectPicker = lazy(() => import("./components/ProjectPicker").then(({ ProjectPicker }) => ({ default: ProjectPicker })));

/** One frozen empty list for both contribution kinds the compact layout leaves out. */
const EMPTY_CONTRIBUTIONS: never[] = [];
const EMPTY_STAGED: ReadonlySet<string> = new Set();

const loadFileUnavailable = async (path: string): Promise<UiFileContent> => ({ path, name: path.split("/").at(-1) ?? path, size: 0, kind: "text", text: "File contents require a document source." });
const loadDiffUnavailable = async (path: string): Promise<UiFileDiff> => ({ path, added: 0, removed: 0, hunks: [], note: "Diffs require a document source." });

export { MountedPanel };

const subscribeToViewport = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const viewportWidth = () => window.innerWidth;
const viewportHeight = () => window.innerHeight;

type DropController = ReturnType<typeof useThreadDropController>;
type Settings = PreferencesState;

/** Commands addressed to the mounted workbench view. */
export interface WorkbenchControlHandle {
  openInstructions(): void;
  focusStage(): void;
  /** Hides or shows the sidebar; on a compact client, the thread sheet. */
  toggleSidebar(): void;
  /** On a compact layout a panel is a sheet: true when this opened or closed one, false where the dock does it. */
  openSheet(id: string): boolean;
  closeSheet(id: string): boolean;
}

/** Window chrome, slots and the modals that belong to the shell. */
export interface WorkbenchLayout {
  controlRef?: RefObject<WorkbenchControlHandle | null>;
  registry: ExtensionRegistry;
  threadStore: ThreadStore;
  settings: Settings;
  /** How wide the client is now, not what it claims to draw (ADR 0016). */
  layoutProfile: ClientProfile;
  workspaceCwd?: string;
  sidebarContributions: ReturnType<ExtensionRegistry["getSidebarContributions"]>;
  panels: ReturnType<ExtensionRegistry["getPanels"]>;
  activePanel: string;
  openedPanels: ReadonlySet<string>;
  openPanel(id: string): void;
  /** Which panels are on the stage, and the moves between dock, drawer and stage. */
  panelLayout?: PanelLayout;
  /** The drawer panel showing below the conversation. */
  drawer?: string;
  dockOpen: boolean;
  setDockOpen(open: boolean): void;
  /** Grows with each call that shows, hides or picks a dock panel. */
  dockAsks: number;
  /** The width this workspace was last left at; the default otherwise. */
  dockWidth?: number;
  onDockWidthChange(width: number): void;
  chatFocused: boolean;
  setChatFocused(focused: boolean): void;
  /** The stage over the whole centre, the chat its first tab; cleared when the stage closes. */
  stageMaximized: boolean;
  setStageMaximized(maximized: boolean): void;
  stage: StageState;
  /** Who holds the handles of the tabs extensions drew, and closes any tab. */
  stageTabs: StageTabController;
  activateStageTab(id: string): void;
  pinStageTab(id: string): void;
  unpinStageTab(id: string): void;
  setStageFileView(id: string, view: "source" | "diff"): void;
  loadThread(sessionId: string): Promise<UiMessage[]>;
  takeOverThread(sessionId: string): void;
  documentState: { changes: UiWorkspaceChanges; editor?: UiEditor };
  documentSource: ReturnType<ExtensionRegistry["getDocumentSource"]>;
  visibleStreaming: boolean;
  paletteOpen: boolean;
  /** The command whose level the palette opens on. */
  paletteMenu?: string;
  closePalette(): void;
  commands: ReturnType<ExtensionRegistry["getCommands"]>;
  projectSourcesOpen: boolean;
  /** The source the project sources open on. */
  projectSource?: string;
  closeProjectSources(): void;
  newThreadOpen: boolean;
  openNewThreadPicker(): void;
  closeNewThreadPicker(): void;
  projects: readonly UiProject[];
  removeProject(project: UiProject): void;
  createThreadInProject(project: UiProject): void;
  settingsPage?: string;
  setSettingsPage(page?: string): void;
  setNotice(message?: string, level?: "info" | "warning" | "error"): void;
  activeOverlayId?: string;
  closeOverlay(): void;
  /** The app page on screen, beside the sidebar. */
  pages: AppPageStore;
}

/** What the visible thread is, and how its transcript is navigated. */
export interface WorkbenchThread {
  snapshot?: HostSnapshot;
  /** The snapshot as the conversation sees it: a draft, or the live run state. */
  conversationSnapshot?: HostSnapshot;
  pendingNewThread: boolean;
  showStartScreen: boolean;
  startProjectPath: string;
  startProjectName: string;
  dropController: DropController;
  transcriptHistory: TranscriptHistoryController;
  transcriptRef: RefObject<HTMLDivElement | null>;
  loadTranscriptPage(sessionId: string, cursor: HostTranscriptCursor): Promise<import("../shared/host-protocol").TranscriptPage>;
  applyTranscriptPage(page: import("../shared/host-protocol").TranscriptPage, request: import("../workbench/transcript-history").TranscriptHistoryRequest): boolean;
  transcriptScopeKey: string;
  transcriptScope: import("../workbench/transcript-navigation").TranscriptNavigationScope;
  transcriptTurnStart?: TranscriptTurnStart;
  visibleTranscriptTurnStart?: TranscriptTurnStart;
  /** The conversation's last message; live tool work anchors there. */
  lastMessageId?: string;
  recoverThread(): Promise<unknown>;
  copyToolOutput(tool: UiToolRun): Promise<void>;
  loadToolOutput(tool: UiToolRun): Promise<UiToolOutputPreview | undefined>;
  runStartedAt?: number;
  activeDraftKey?: string;
  copyMessage(message: UiMessage): Promise<void>;
  forkMessage(message: UiMessage): Promise<void>;
  /** Rewinds the conversation to before a prompt and puts the prompt back into the composer. */
  editMessage(message: UiMessage): Promise<void>;
  titleCommands: ReturnType<ExtensionRegistry["getCommandsFor"]>;
  openThreadTree(mode?: ThreadTreeMode): void;
  duplicateThread(): Promise<boolean>;
  settleActiveThread(): void;
  renameThread(title: string): Promise<boolean>;
  copyThreadValue(kind: "chat" | "path" | "thread-id"): Promise<void>;
  threadTreeModal?: { tree?: UiThreadTree; mode: ThreadTreeMode; busy: boolean; error?: string };
  closeThreadTree(): void;
  navigateThreadTree(entryId: string, summarize: boolean): Promise<void>;
  forkFromTree(entryId: string): Promise<void>;
}

/** Everything the composer needs, including what it sends and what it waits on. */
export interface WorkbenchComposer {
  controlRef?: RefObject<ComposerControlHandle | null>;
  scopeStore: ComposerScopeStore;
  seed?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachmentRef: RefObject<ComposerAttachmentHandle | null>;
  queue: readonly UiQueuedMessage[];
  holds: number;
  prompts: ExtensionUiPrompt[];
  submit: (value: string, attachments?: import("../shared/contracts").UiPromptAttachment[], delivery?: "followUp" | "steer" | "alternate", skillDraft?: import("../shared/contracts").UiSkillDraft) => Promise<SubmitResult>;
  abort(sessionId?: string): void;
  cancelQueued(id: string): void;
  steerQueued(id: string): void;
  reorderQueue(id: string, toIndex: number): void;
  /** Takes a queued message back into the composer. */
  returnQueued(id: string): void;
  setModel(provider: string, id: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  /** Binds the draft to another runtime; it keeps what it chose for each. */
  selectRuntime?(kind: string): void;
  /** The next draft starts on this runtime's model. */
  carryModel?(runtime: string, model: import("../shared/contracts").UiModel): void;
  answerUiPrompt(id: string, answer: import("../shared/contracts").ExtensionUiAnswer): void;
  compactContext(): Promise<void>;
}

export interface WorkbenchModel {
  /** The one store the transcript and the context meter subscribe to themselves. */
  view: ThreadViewStore;
  /** The toast stack; notices reach it through `setNotice`. */
  toasts: ToastStore;
  actions: WorkbenchActions;
  /** Both contexts without their tool runs, which the workbench adds from `view`. */
  context: Omit<WorkbenchContextValue, "tools">;
  shellContext: WorkbenchShellContextValue;
  observatoryContext: Omit<ObservatoryContextValue, "tools">;
  layout: WorkbenchLayout;
  thread: WorkbenchThread;
  composer: WorkbenchComposer;
}

export const Workbench = memo(function Workbench({ model }: { model: WorkbenchModel }) {
  const { actions, layout, thread, composer, view, toasts } = model;
  const {
    registry, threadStore, settings, layoutProfile, workspaceCwd, sidebarContributions: allSidebarContributions, panels: allPanels, activePanel,
    openedPanels, openPanel, panelLayout, drawer, dockOpen, setDockOpen, dockAsks, dockWidth: restoredDockWidth, onDockWidthChange,
    chatFocused, setChatFocused, stageMaximized, setStageMaximized, stage, stageTabs, activateStageTab, pinStageTab, unpinStageTab, setStageFileView,
    loadThread, takeOverThread,
    documentState, documentSource, visibleStreaming, paletteOpen, paletteMenu, closePalette, commands,
    projectSourcesOpen, projectSource, closeProjectSources, newThreadOpen, openNewThreadPicker, closeNewThreadPicker,
    projects, removeProject, createThreadInProject, settingsPage, setSettingsPage,
    setNotice, activeOverlayId, closeOverlay, pages,
  } = layout;
  const {
    snapshot, conversationSnapshot, pendingNewThread, showStartScreen, startProjectPath, startProjectName,
    dropController, activeDraftKey, titleCommands, openThreadTree, duplicateThread, settleActiveThread,
    renameThread, copyThreadValue, threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  } = thread;
  const {
    setModel, setThinking,
  } = composer;
  const clientStorage = useClientStorage();
  const preferences = usePreferences();
  const hostCapabilities = useHostCapabilities();
  const platform = usePlatform();
  // Sidebar width and drawer height belong to this client, not to a workspace.
  const windowWidth = useSyncExternalStore(subscribeToViewport, viewportWidth);
  const windowHeight = useSyncExternalStore(subscribeToViewport, viewportHeight);
  const [sidebarWidth, setSidebarWidthState] = useState(() => storedSidebarWidth(clientStorage.get(STORAGE_KEYS.sidebarWidth)));
  const setSidebarWidth = (width: number) => {
    setSidebarWidthState(width);
    clientStorage.set(STORAGE_KEYS.sidebarWidth, String(width));
  };
  const [drawerHeight, setDrawerHeightState] = useState(() => storedDrawerHeight(clientStorage.get(STORAGE_KEYS.drawerHeight)));
  const setDrawerHeight = (height: number) => {
    setDrawerHeightState(height);
    clientStorage.set(STORAGE_KEYS.drawerHeight, String(height));
  };
  const [dockWidth, setDockWidthState] = useState(() => storedDockWidth(clientStorage));
  // The workspace's own width arrives with its restored dock state.
  useEffect(() => {
    if (restoredDockWidth !== undefined) setDockWidthState(clampDockWidth(restoredDockWidth));
  }, [restoredDockWidth]);
  // One screen wide: the thread list is a screen of its own and the dock has nowhere to go.
  // The registry still holds those contributions; only this layout leaves them out.
  const compact = layoutProfile === "compact";
  // A tablet-sized compact client keeps the list beside the thread instead.
  const clientProfile = useClientEnvironment().profile;
  const split = compact && compactFormFor(clientProfile, windowWidth, windowHeight) === "split";
  const compactRef = useRef({ compact, split, sheets: [] as readonly string[] });
  compactRef.current = { ...compactRef.current, compact, split };
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [touchSidebarOpen, setTouchSidebarOpen] = useState(true);
  // The project the touch thread list is narrowed to; a new thread from it starts there.
  const [touchProjectPath, setTouchProjectPath] = useState<string>();
  const touchProject = touchProjectPath === undefined ? undefined : projects.find((project) => project.path === touchProjectPath);
  // A phone with no thread open shows its thread list as the start page, not an empty composer.
  const phoneHome = compact && !split && showStartScreen && !pendingNewThread;
  // On a compact layout a panel that claims `compact` opens over the thread; F10 and F11 add theirs here.
  const [panelSheet, setPanelSheet] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(() => clientStorage.get(STORAGE_KEYS.sidebarOpen) !== "false");
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const openPage = useSyncExternalStore(pages.subscribe, pages.getSnapshot);
  // A phone shows a page as a screen of its own; elsewhere it takes the thread's place beside the sidebar.
  const pageScreen = compact && !split;
  useCloseOnThreadChange(pages, snapshot?.sessionId, pendingNewThread);
  const stageRef = useRef<HTMLElement>(null);
  useImperativeHandle(layout.controlRef, () => ({
    openInstructions: () => setSystemPromptOpen(true),
    focusStage: () => stageRef.current?.focus(),
    toggleSidebar: () => {
      if (compactRef.current.split) { setTouchSidebarOpen((open) => !open); return; }
      if (compactRef.current.compact) { setThreadSheetOpen((open) => !open); return; }
      setSidebarOpen((open) => {
        clientStorage.set(STORAGE_KEYS.sidebarOpen, String(!open));
        return !open;
      });
    },
    openSheet: (id) => {
      if (!compactRef.current.sheets.includes(id)) return false;
      setThreadSheetOpen(false);
      setPanelSheet(id);
      return true;
    },
    closeSheet: (id) => {
      if (!compactRef.current.sheets.includes(id)) return false;
      setPanelSheet((open) => (open === id ? undefined : open));
      return true;
    },
  }), [clientStorage]);
  const sidebarContributions = compact ? EMPTY_CONTRIBUTIONS : allSidebarContributions;
  const panels = compact ? EMPTY_CONTRIBUTIONS : allPanels;
  const sheetPanels = useMemo(() => compact ? allPanels.filter((panel) => rendersOnProfile(panel.profiles, "compact")) : EMPTY_CONTRIBUTIONS, [allPanels, compact]);
  const sheetPanel = sheetPanels.find((panel) => panel.id === panelSheet);
  compactRef.current.sheets = sheetPanels.map((panel) => panel.id);
  const dockPanels = useMemo(() => panels.filter((panel) => panel.placement !== "drawer"), [panels]);
  const drawerPanels = useMemo(() => panels.filter((panel) => panel.placement === "drawer"), [panels]);
  const staged = panelLayout?.staged ?? EMPTY_STAGED;
  const drawerPanel = drawerPanels.find((panel) => panel.id === drawer && !staged.has(panel.id));
  const hostFor = usePanelHosts();
  const activeDockPanel = dockPanels.find((panel) => panel.id === activePanel);
  const maximizeShortcut = registry.keybindingLabel?.("rightPanel.toggleMaximized");
  const sidebarShown = sidebarOpen && sidebarContributions.length > 0;
  const shownSidebar = sidebarShown ? shownSidebarWidth(sidebarWidth, windowWidth) : 0;
  const touchSidebarShown = split && touchSidebarOpen;
  const drawnSidebar = split ? (touchSidebarShown ? compactSidebarWidth(windowWidth) : 0) : shownSidebar;
  const stageOpen = stage.tabs.length > 0;
  const clearStageMaximized = useCallback(() => setStageMaximized(false), [setStageMaximized]);
  // A compact client draws no stage (profile-compact.css), so its chat never becomes a tab.
  const { dockYields, tabs: centerCompact, canSplit, keepDock } = useCenterLayout({
    windowWidth, sidebarWidth: drawnSidebar, stageOpen: stageOpen && !compact, maximized: stageMaximized,
    tabCount: stage.tabs.length, dockAsks, clearMaximized: clearStageMaximized,
    ...(dockPanels.length > 0 ? { dock: { open: dockOpen, width: dockWidth } } : {}),
  });
  const dockShown = dockOpen && !dockYields;
  useEffect(() => { if (!compact || split) setThreadSheetOpen(false); }, [compact, split]);
  // Opening another thread (from a panel, say) puts the thread in front again.
  useEffect(() => { setPanelSheet(undefined); }, [compact, snapshot?.sessionId]);

  const setDockWidth = (width: number) => {
    const bounded = clampDockWidth(width);
    setDockWidthState(bounded);
    clientStorage.set(DOCK_WIDTH_KEY, String(bounded));
    onDockWidthChange(bounded);
  };

  const centerClassName = [
    "workbench-center",
    stageOpen ? "stage-open" : "",
    centerCompact ? "compact" : "",
    centerCompact && chatFocused ? "chat-focused" : "",
  ].filter(Boolean).join(" ");
  const shellClassName = [
    "app-shell",
    split ? "touch-split" : "",
    sidebarContributions.length === 0 && !split ? "no-sidebar" : "",
    (split ? touchSidebarOpen : sidebarOpen) ? "" : "sidebar-closed",
    dockPanels.length === 0 ? "no-dock" : "",
    dockShown ? "" : "dock-closed",
  ].filter(Boolean).join(" ");

  const openSupervisedThread = (row: { path: string }) => {
    setThreadSheetOpen(false);
    void actions.switchSession(row.path);
  };
  // In the filtered project, else where the host last worked; with neither, ask.
  const startTouchThread = () => {
    setThreadSheetOpen(false);
    const project = touchProject ?? lastUsedProject(projects, threadStore.getSnapshot().threads);
    if (project) createThreadInProject(project);
    else openNewThreadPicker();
  };
  const threadBrowserProps = {
    registry,
    actions,
    onOpen: openSupervisedThread,
    onStop: (row: { id: string }) => composer.abort(row.id),
    project: touchProject,
    projects,
    onProjectChange: (project: UiProject | undefined) => setTouchProjectPath(project?.path),
    onNewThread: startTouchThread,
    onOpenSettings: (page?: string) => { setThreadSheetOpen(false); actions.openSettings(page); },
  };

  const conversationComposer = <ConversationComposer
    view={view}
    composer={composer}
    snapshot={snapshot}
    conversationSnapshot={conversationSnapshot}
    pendingNewThread={pendingNewThread}
    showStartScreen={showStartScreen}
    activeDraftKey={activeDraftKey}
    onNotify={actions.notify}
    actions={actions}
  />;

  const appPage = openPage ? <LazyFeatureBoundary label="page">
    <Suspense fallback={<section className={`app-page${pageScreen ? " stacked" : ""}`}><LazyFeatureFallback label="page" /></section>}>
      <LazyAppPageScreen registry={registry} store={pages} actions={actions} stacked={pageScreen} sidebarShown={split ? touchSidebarShown : sidebarShown} />
    </Suspense>
  </LazyFeatureBoundary> : null;

  const overlays = <>
    {compact ? <Suspense fallback={null}><LazyTouchLayer syncUrl={clientProfile !== "desktop"} openThread={actions.switchSession} /></Suspense> : null}
    {phoneHome && !threadSheetOpen ? <Suspense fallback={null}>
      <LazyTouchThreadBrowser variant="home" {...threadBrowserProps} />
    </Suspense> : null}
    {compact && threadSheetOpen ? <Suspense fallback={null}>
      <LazyTouchThreadBrowser variant="screen" {...threadBrowserProps} onClose={() => setThreadSheetOpen(false)} />
    </Suspense> : null}
    {sheetPanel ? <Suspense fallback={null}>
      <LazyPanelSheet label={sheetPanel.label} host={hostFor(sheetPanel.id)} onClose={() => setPanelSheet(undefined)} />
    </Suspense> : null}
    {threadTreeModal ? <Suspense fallback={null}><LazyThreadTreeModal
      tree={threadTreeModal.tree} mode={threadTreeModal.mode} busy={threadTreeModal.busy} error={threadTreeModal.error}
      onClose={closeThreadTree} onNavigate={(entryId, summarize) => void navigateThreadTree(entryId, summarize)} onFork={(entryId) => void forkFromTree(entryId)}
    /></Suspense> : null}
    {systemPromptOpen ? (
      <Suspense fallback={<LazyFeatureFallback label="system prompt" />}>
        <LazySystemPromptModal threadId={snapshot?.sessionId} onClose={() => setSystemPromptOpen(false)} />
      </Suspense>
    ) : null}
    <LazyFeatureBoundary label="command palette">
      <Suspense fallback={<LazyFeatureFallback label="command palette" />}>
        <LazyCommandPalette
          open={paletteOpen}
          {...(paletteMenu ? { menu: paletteMenu } : {})}
          shortcutFor={(commandId) => registry.keybindingLabel(commandId)}
          commands={commands}
          extensionCount={registry.getExtensionNames().length}
          actions={actions}
          registry={registry}
          onClose={closePalette}
        />
      </Suspense>
    </LazyFeatureBoundary>
    {projectSourcesOpen ? <Suspense fallback={null}>
      <LazyProjectSourcesModal actions={actions} onClose={closeProjectSources} sources={registry.getProjectSources()} {...(projectSource ? { initialSource: projectSource } : {})} />
    </Suspense> : null}
    <Suspense fallback={null}>
      <LazyProjectPicker
        open={newThreadOpen}
        projects={projects}
        onBrowse={() => actions.openProjectSources()}
        onClose={closeNewThreadPicker}
        onRemove={removeProject}
        onSelect={createThreadInProject}
      />
    </Suspense>
    {openPage && pageScreen ? appPage : null}
    {settingsPage ? <LazyFeatureBoundary label="settings">
      <Suspense fallback={<div className="settings-screen loading"><LazyFeatureFallback label="settings" /></div>}>
        <LazySettingsScreen
          page={settingsPage}
          stacked={compact && !split}
          snapshot={snapshot}
          registry={registry}
          projects={projects}
          onSetPage={setSettingsPage}
          onSetModel={(provider, id) => void setModel(provider, id)}
          onSetThinking={(level) => void setThinking(level)}
          onClose={() => setSettingsPage(undefined)}
          onNotify={setNotice}
        />
      </Suspense>
    </LazyFeatureBoundary> : null}
  </>;

  // One of each for the whole window, over the shell, an overlay and Settings alike.
  const floats = <>
    <ToastLayer store={toasts} placement={compact ? "bottom" : "top"} />
    <TooltipLayer />
    <ContextMenuLayer />
    <PairingRequestWatcher onNotify={actions.notify} />
  </>;

  const activeOverlay = registry.getOverlay(activeOverlayId);
  const providers = (content: React.ReactNode) => <WorkbenchProviders model={model} threadStore={threadStore}>{content}</WorkbenchProviders>;
  if (activeOverlay) return providers(<>
    <LazyFeatureBoundary
      label={activeOverlay.id}
      extensionId={activeOverlay.extensionId}
      extensionName={activeOverlay.extensionName}
      registry={registry}
      onNotify={actions.notify}
    >
      <Suspense fallback={<LazyFeatureFallback label={activeOverlay.id} />}>
        <activeOverlay.Component actions={actions} onClose={closeOverlay} />
      </Suspense>
    </LazyFeatureBoundary>
    {overlays}
    {floats}
  </>);

  return providers(<>
    {/* Settings covers the shell rather than unmounting it, so threads, terminals and scroll stay as they were. */}
    <div className={shellClassName} inert={Boolean(settingsPage) || phoneHome} style={{ "--dock-width": dockPanels.length === 0 || !dockShown ? "0px" : `${dockWidth}px`, "--sidebar-width": `${drawnSidebar}px` } as CSSProperties}>
      <TitleBar
        cwd={workspaceCwd}
        dockOpen={dockShown}
        hasDock={dockPanels.length > 0}
        registry={registry}
        snapshot={snapshot}
        actions={actions}
        thread={showStartScreen ? <span className="title-draft">New thread</span> : <>
          <Region registry={registry} placement="thread-title" snapshot={snapshot} actions={actions} />
          <ThreadTitleMenu
            title={conversationSnapshot?.sessionTitle || "Untitled thread"}
            label={snapshot?.projectLabel}
            pinned={Boolean(snapshot?.sessionId && settings.pinnedThreadIds.includes(snapshot.sessionId))}
            settled={Boolean(snapshot?.sessionId && settings.settledThreadIds.includes(snapshot.sessionId))}
            onNewThread={openNewThreadPicker}
            onOpenTree={() => openThreadTree("navigate")}
            onOpenInstructions={() => setSystemPromptOpen(true)}
            onDuplicate={() => void duplicateThread()}
            onTogglePin={() => { if (snapshot?.sessionId) preferences.togglePinned(snapshot.sessionId); }}
            onToggleSettled={settleActiveThread}
            onRename={renameThread}
            commands={titleCommands}
            onCommand={(id) => { void titleCommands.find((command) => command.id === id)?.run(actions); }}
            onMarkUnread={() => { if (snapshot?.sessionId) threadStore.markUnread(snapshot.sessionId); }}
            onCopy={(kind) => void copyThreadValue(kind)}
            canCopyPath={hostCapabilities.localFiles}
          />
        </>}
        drawers={drawerPanels.map((panel) => ({
          id: panel.id,
          label: panel.label,
          open: drawer === panel.id,
          onToggle: () => (drawer === panel.id ? actions.closePanel?.(panel.id) : openPanel(panel.id)),
        }))}
        onToggleDock={() => (dockYields ? keepDock() : setDockOpen(!dockOpen))}
        {...(compact ? { onOpenThreads: () => (split ? setTouchSidebarOpen((open) => !open) : setThreadSheetOpen(true)) } : {})}
        sheets={sheetPanels.map((panel) => ({
          id: panel.id,
          label: panel.label,
          Icon: panel.Icon,
          open: panelSheet === panel.id,
          onToggle: () => setPanelSheet((open) => (open === panel.id ? undefined : panel.id)),
        }))}
      />
      {split ? <div className="sidebar-slot">
        <Suspense fallback={<aside className="touch-browser sidebar" />}><LazyTouchThreadBrowser variant="sidebar" {...threadBrowserProps} /></Suspense>
      </div> : null}
      <div className="sidebar-slot">{sidebarContributions.map((contribution) => <LazyFeatureBoundary
        key={contribution.id}
        label="sidebar"
        extensionId={contribution.extensionId}
        extensionName={contribution.extensionName}
        registry={registry}
        onNotify={actions.notify}
      >
        <Suspense fallback={<LazyFeatureFallback label="sidebar" />}><contribution.Component actions={actions} /></Suspense>
      </LazyFeatureBoundary>)}</div>
      {sidebarShown && !compact ? <ResizeHandle
        className="sidebar-resizer"
        label="Resize sidebar"
        orientation="vertical"
        grows="right"
        value={shownSidebar}
        min={SIDEBAR_MIN_WIDTH}
        max={sidebarMaxWidth(windowWidth)}
        defaultValue={SIDEBAR_DEFAULT_WIDTH}
        onChange={setSidebarWidth}
      /> : null}
      <div className="workbench-main" inert={Boolean(openPage) && !pageScreen}>
      <div className={centerClassName}>
        <main
          className={`conversation-column ${showStartScreen ? "conversation-start" : ""}`}
          onDragEnter={dropController.onDragEnter}
          onDragOver={dropController.onDragOver}
          onDragLeave={dropController.onDragLeave}
          onDrop={dropController.onDrop}
        >
          {dropController.state !== "idle" ? <div className={`conversation-drop-overlay ${dropController.state}`} role="status" aria-live="polite">
            <div className="conversation-drop-card">
              <strong>{THREAD_DROP_FEEDBACK[dropController.state].title}</strong>
              <span>{THREAD_DROP_FEEDBACK[dropController.state].description}</span>
            </div>
          </div> : null}
          <section className="conversation-start-screen" aria-labelledby={showStartScreen ? "start-screen-title" : undefined}>
            <div className="conversation-start-content">
              {showStartScreen ? <>
                <h1 id="start-screen-title">What do you want to build?</h1>
                <button type="button" className="conversation-start-project" aria-label={`Change project, current project ${startProjectName}`} onClick={openNewThreadPicker}>
                  <i><Folder size={17} /></i>
                  <span><small>Current project</small><strong>{startProjectName}</strong><code {...tooltipProps(startProjectPath, { variant: "code", side: "bottom" })}>{displayPath(startProjectPath)}</code></span>
                  <b>Change</b><ChevronDown size={15} />
                </button>
              </> : null}
              <Region registry={registry} placement="composer-above" snapshot={snapshot} actions={actions} />
              <ComposerHost start={showStartScreen}>{conversationComposer}</ComposerHost>
              <Region registry={registry} placement="composer-below" snapshot={snapshot} actions={actions} />
            </div>
          </section>
          <div className="conversation-thread">
            {!showStartScreen ? <>
              <Region registry={registry} placement="transcript-header" snapshot={snapshot} actions={actions} />
              {snapshot?.sessionId ? <ThreadRuntimeBanner
                sessionId={snapshot.sessionId}
                onRetry={(path) => void actions.switchSession(path)}
                onOpenProviders={() => actions.openSettings("providers")}
              /> : null}
              <ConversationTranscript view={view} thread={thread} registry={registry} actions={actions} prompts={composer.prompts} abort={composer.abort} composer={composer} />
              <Region registry={registry} placement="transcript-footer" snapshot={snapshot} actions={actions} />
            </> : null}
          </div>
          <HostConnectionStatus />
          <StatusLine registry={registry} snapshot={snapshot} actions={actions} />
        </main>
        {stage.tabs.length > 0 ? <LazyFeatureBoundary label="stage">
          <Suspense fallback={<section className="stage"><LazyFeatureFallback label="stage" /></section>}>
            <LazyStage
              focusRef={stageRef}
              stage={stage}
              cwd={snapshot?.cwd}
              changes={documentState.changes}
              editor={documentState.editor}
              chatTab={centerCompact ? { active: chatFocused, streaming: visibleStreaming, onSelect: setChatFocused } : undefined}
              maximize={canSplit ? { maximized: stageMaximized, onToggle: () => { setChatFocused(false); setStageMaximized(!stageMaximized); } } : undefined}
              registry={registry}
              stageTabs={stageTabs}
              actions={actions}
              loadFile={documentSource?.loadFile ?? loadFileUnavailable}
              loadDiff={documentSource?.loadDiff ?? loadDiffUnavailable}
              loadThread={loadThread}
              onActivate={activateStageTab}
              onClose={stageTabs.close}
              onPin={pinStageTab}
              onUnpin={unpinStageTab}
              onCloseOthers={stageTabs.closeOthers}
              onCloseToRight={stageTabs.closeToTheRight}
              onChangeView={setStageFileView}
              onOpenInEditor={(path) => platform.files?.openInEditor(path)}
              onTakeOverThread={takeOverThread}
              renderPanel={(panelId) => {
                const panel = panels.find((entry) => entry.id === panelId);
                if (!panel) return null;
                return <PanelSlot host={hostFor(panel.id)} />;
              }}
            />
          </Suspense>
        </LazyFeatureBoundary> : null}
      </div>
      {drawerPanel ? <section className="workbench-drawer" aria-label={drawerPanel.label} style={{ height: shownDrawerHeight(drawerHeight, windowHeight) }}>
        <ResizeHandle
          className="drawer-resizer"
          label={`Resize ${drawerPanel.label} drawer`}
          orientation="horizontal"
          grows="up"
          value={shownDrawerHeight(drawerHeight, windowHeight)}
          min={DRAWER_MIN_HEIGHT}
          max={drawerMaxHeight(windowHeight)}
          defaultValue={DRAWER_DEFAULT_HEIGHT}
          onChange={setDrawerHeight}
        />
        <PanelSlot host={hostFor(drawerPanel.id)} />
        {drawerPanel.maximizable ? <PanelMaximizeButton label={drawerPanel.label} shortcut={maximizeShortcut} onMaximize={() => panelLayout?.maximize(drawerPanel.id)} /> : null}
      </section> : null}
      </div>
      {dockPanels.length > 0 ? <aside className="instrument-dock" inert={Boolean(openPage) && !pageScreen}>
        {dockShown ? <ResizeHandle
          className="dock-resizer"
          label="Resize right sidebar"
          orientation="vertical"
          grows="left"
          value={dockWidth}
          min={MIN_DOCK_WIDTH}
          max={MAX_DOCK_WIDTH}
          defaultValue={DEFAULT_DOCK_WIDTH}
          onChange={setDockWidth}
        /> : null}
        {dockShown ? <div className="panel-stage">
          {dockPanels.map((panel) => openedPanels.has(panel.id) && !staged.has(panel.id) ? <PanelSlot key={panel.id} host={hostFor(panel.id)} /> : null)}
          {staged.has(activePanel) ? <div className="panel-on-stage" role="status">
            <p>{activeDockPanel?.label ?? "This panel"} is open as a tab.</p>
            <button type="button" className="chrome-button" onClick={() => openPanel(activePanel)}>Show tab</button>
            <button type="button" className="chrome-button" onClick={() => panelLayout?.restore(activePanel)}>Move back here</button>
          </div> : activeDockPanel?.maximizable && panelLayout ? <PanelMaximizeButton label={activeDockPanel.label} shortcut={maximizeShortcut} onMaximize={() => panelLayout.maximize(activeDockPanel.id)} /> : null}
        </div> : null}
        <nav className="panel-rail">
          {dockPanels.map((panel) => {
            const onStage = staged.has(panel.id);
            const shown = dockShown && activePanel === panel.id && !onStage;
            return <button
              key={panel.id}
              {...tooltipProps(onStage ? `${panel.label} (open as a tab)` : panel.label, { side: "left" })}
              aria-label={panel.label}
              className={[shown ? "active" : "", onStage ? "on-stage" : ""].filter(Boolean).join(" ")}
              aria-pressed={shown}
              onClick={() => shown ? setDockOpen(false) : openPanel(panel.id)}
            ><PanelIcon Icon={panel.Icon} /></button>;
          })}
          <span className="spacer" />
        </nav>
      </aside> : null}
      {openPage && !pageScreen ? appPage : null}
    </div>
    {overlays}
    {floats}
    {sheetPanel ? createPortal(<MountedPanel
      Component={sheetPanel.Component}
      active
      placement="stage"
      label={sheetPanel.label}
      extensionId={sheetPanel.extensionId}
      extensionName={sheetPanel.extensionName}
      registry={registry}
      actions={actions}
      onNotify={actions.notify}
    />, hostFor(sheetPanel.id), sheetPanel.id) : null}
    {panels.map((panel) => {
      const onStage = staged.has(panel.id);
      const inDrawer = panel.placement === "drawer";
      if (!(onStage || (inDrawer ? drawer === panel.id : dockShown && openedPanels.has(panel.id)))) return null;
      const placement = onStage ? "stage" : inDrawer ? "drawer" : "dock";
      const active = onStage
        ? stage.activeId === panelTabId(panel.id) && !(centerCompact && chatFocused)
        : inDrawer || (dockShown && activePanel === panel.id);
      return createPortal(<MountedPanel
        Component={panel.Component}
        active={active}
        placement={placement}
        label={panel.label}
        extensionId={panel.extensionId}
        extensionName={panel.extensionName}
        registry={registry}
        actions={actions}
        onNotify={actions.notify}
      />, hostFor(panel.id), panel.id);
    })}
  </>);
});

/**
 * Tool runs join the two contexts here. A flush of tool output re-renders this
 * and the contexts' consumers; the workbench below hands in the same children.
 */
function WorkbenchProviders({ model, threadStore, children }: { model: WorkbenchModel; threadStore: ThreadStore; children: React.ReactNode }) {
  const { tools } = useSyncExternalStore(model.view.subscribeToTools, model.view.getToolView);
  const context = useMemo(() => ({ ...model.context, tools }), [model.context, tools]);
  const observatory = useMemo(() => ({ ...model.observatoryContext, tools }), [model.observatoryContext, tools]);
  return <ThreadStoreContext.Provider value={threadStore}>
    <WorkbenchShellContext.Provider value={model.shellContext}>
      <WorkbenchContext.Provider value={context}>
        <AppPageContext.Provider value={model.layout.pages}>
          <ObservatoryContext.Provider value={observatory}>{children}</ObservatoryContext.Provider>
        </AppPageContext.Provider>
      </WorkbenchContext.Provider>
    </WorkbenchShellContext.Provider>
  </ThreadStoreContext.Provider>;
}

/** Another thread on screen, or a new one's draft, leaves the open page. */
function useCloseOnThreadChange(pages: AppPageStore, sessionId: string | undefined, draft: boolean): void {
  const shown = useRef({ sessionId, draft });
  useEffect(() => {
    if (shown.current.sessionId === sessionId && shown.current.draft === draft) return;
    shown.current = { sessionId, draft };
    pages.close();
  }, [draft, pages, sessionId]);
}

/**
 * The transcript follows the store on its own. A streamed delta or a flush of
 * tool output re-renders this subtree and leaves the rest of the workbench untouched.
 */
function ConversationTranscript({ view, thread, registry, actions, prompts, abort, composer }: {
  view: ThreadViewStore;
  thread: WorkbenchThread;
  registry: ExtensionRegistry;
  composer: WorkbenchComposer;
  actions: WorkbenchActions;
  prompts: readonly ExtensionUiPrompt[];
  abort(sessionId?: string): void;
}) {
  const transcript = useSyncExternalStore(view.subscribeToTranscript, view.getTranscript);
  const optimistic = useSyncExternalStore(view.subscribeToOptimistic, view.getOptimisticMessages);
  const preferences = usePreferences();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const {
    snapshot, conversationSnapshot, pendingNewThread, transcriptHistory, transcriptRef, loadTranscriptPage,
    applyTranscriptPage, transcriptScopeKey, transcriptScope, transcriptTurnStart,
    visibleTranscriptTurnStart, lastMessageId, recoverThread, copyToolOutput, loadToolOutput,
    runStartedAt, activeDraftKey, copyMessage, forkMessage, editMessage,
  } = thread;
  const detail = preferences.transcriptDetailFor(conversationSnapshot?.sessionId);
  const { conversationActivityTools, liveStatusLabel, transcriptActivities } = useConversationActivities({
    pendingNewThread, conversationSnapshot, running: Boolean(snapshot?.isStreaming), lastMessageId, prompts,
    registry, viewStore: view, detail, actions, recoverThread, copyToolOutput, loadToolOutput,
    abortSessionId: snapshot?.sessionId, abort,
  });
  const messages = useMemo(
    () => conversationMessagesFor(transcript.messages, optimistic, activeDraftKey, pendingNewThread),
    [activeDraftKey, optimistic, pendingNewThread, transcript],
  );
  // Stable across renders: a new callback or status element per tool flush
  // would re-render every visible message and restart the tail follow.
  const onCopyMessage = useCallback((message: UiMessage) => void copyMessage(message), [copyMessage]);
  const onForkMessage = useCallback((message: UiMessage) => void forkMessage(message), [forkMessage]);
  const onEditMessage = useCallback((message: UiMessage) => void editMessage(message), [editMessage]);
  const { readOnly } = useHostCapabilities();
  const showRunClock = Boolean(conversationSnapshot?.isStreaming) && conversationActivityTools.length === 0;
  const { queue, steerQueued, returnQueued, reorderQueue } = composer;
  const running = Boolean(conversationSnapshot?.isStreaming);
  const steerShortcut = registry.keybindingLabel("thread.steerQueuedMessage");
  const shell = useThreadShell(conversationSnapshot?.sessionId ?? "");
  // An answer that carries its error shows it in place; the line is for runtimes whose failure has no answer.
  const failedAnswer = messages.at(-1)?.error !== undefined;
  const turnError = pendingNewThread || running || failedAnswer ? undefined : shell?.turnError;
  // Stable across deltas, like the callbacks above.
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  const { submit } = composer;
  const retry = useCallback((failed?: UiMessage) => {
    const prompt = retryPrompt(latestMessages.current, failed);
    if (prompt) void submit(prompt.text, prompt.attachments);
  }, [submit]);
  // A provider limit replaces the failure line: it says when, and offers to continue.
  const limit = pendingNewThread || running ? undefined : shell?.limit;
  const queueHeld = shell?.queueHeld === true;
  const liveStatus = useMemo(() => {
    const status = liveStatusLabel !== undefined
      ? <LiveStatus label={liveStatusLabel} />
      : showRunClock ? <LiveStatus startedAt={runStartedAt} />
      : limit && conversationSnapshot ? <Suspense fallback={null}><LazyLimitNotice sessionId={conversationSnapshot.sessionId} limit={limit} /></Suspense>
      : turnError ? <TurnErrorLine message={turnError} onRetry={readOnly ? undefined : () => retry()} /> : undefined;
    if (pendingNewThread || queue.length === 0) return status;
    return <>{status}<QueuedMessages queue={queue} streaming={running} held={queueHeld} steerShortcut={steerShortcut} onSteer={steerQueued} onReturn={returnQueued} onReorder={reorderQueue} /></>;
  }, [conversationSnapshot, limit, liveStatusLabel, pendingNewThread, queue, queueHeld, readOnly, reorderQueue, retry, returnQueued, runStartedAt, running, showRunClock, steerQueued, steerShortcut, turnError]);
  return <TranscriptHistoryBoundary
    controller={transcriptHistory}
    scrollRef={transcriptRef}
    showControl={!pendingNewThread && messages.length > 0}
    loadPage={loadTranscriptPage}
    applyPage={applyTranscriptPage}
  >
    {(loadOlderOnReach) => <TranscriptViewport
      messages={messages}
      scrollRef={transcriptRef}
      sessionId={conversationSnapshot?.sessionId}
      scopeKey={transcriptScopeKey}
      revision={transcript.revision}
      lookupRevision={transcript.lookupRevision}
      scope={transcriptTurnStart?.scope ?? transcriptScope}
      turnStart={visibleTranscriptTurnStart}
      isStreaming={Boolean(conversationSnapshot?.isStreaming)}
      activities={transcriptActivities}
      detail={detail}
      liveStatus={liveStatus}
      onCopyMessage={onCopyMessage}
      // A Read-only device may not rewind or fork; the buttons are left out.
      onForkMessage={readOnly ? undefined : onForkMessage}
      onEditMessage={readOnly ? undefined : onEditMessage}
      onRetryMessage={readOnly || limit ? undefined : retry}
      onReachStart={loadOlderOnReach}
    />}
  </TranscriptHistoryBoundary>;
}

/** The context meter reads the running token estimate, so the composer subscribes too. */
function ConversationComposer({ view, composer, snapshot, conversationSnapshot, pendingNewThread, showStartScreen, activeDraftKey, onNotify, actions }: {
  view: ThreadViewStore;
  composer: WorkbenchComposer;
  snapshot?: HostSnapshot;
  conversationSnapshot?: HostSnapshot;
  pendingNewThread: boolean;
  showStartScreen: boolean;
  activeDraftKey?: string;
  onNotify?(message: string): void;
  actions?: WorkbenchActions;
}) {
  const transcript = useSyncExternalStore(view.subscribeToTranscript, view.getTranscript);
  // Only at the meter's precision: tool output would otherwise re-render the composer every frame.
  const toolKiloTokens = useSyncExternalStore(view.subscribeToTools, () => toolOutputKiloTokens(view.getToolView().tools));
  const preferences = usePreferences();
  const { showCosts, newThreadRuntime } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // The runtime is a property of the thread; it is chosen before the thread exists and never after.
  const runtimeBackends = snapshot?.runtimeBackends ?? [];
  const runtimeChoice = pendingNewThread && runtimeBackends.length > 1
    ? { kind: effectiveNewThreadRuntime(newThreadRuntime, snapshot), backends: runtimeBackends, onSelect: (kind: string) => (composer.selectRuntime ? composer.selectRuntime(kind) : preferences.setNewThreadRuntime(kind)) }
    : undefined;
  const {
    scopeStore, seed, textareaRef, attachmentRef, controlRef, queue, holds, prompts, submit, abort,
    cancelQueued, steerQueued, setModel, setThinking, answerUiPrompt, compactContext,
  } = composer;
  const contextBreakdown = useMemo(
    () => contextBreakdownFor(snapshot?.contextUsage, transcript.tokenEstimate, toolKiloTokens * 1000),
    [snapshot?.contextUsage, toolKiloTokens, transcript.tokenEstimate],
  );
  return <Composer
    snapshot={conversationSnapshot}
    scopeStore={scopeStore}
    seed={seed}
    draftStorageKey={activeDraftKey}
    queue={queue}
    contextUsage={snapshot?.contextUsage}
    contextBreakdown={contextBreakdown}
    threadUsage={showCosts && !showStartScreen ? snapshot?.usage : undefined}
    textareaRef={textareaRef}
    attachmentRef={attachmentRef}
    controlRef={controlRef}
    onSubmit={(text, attachments, delivery, skillDraft) => submit(text ?? "", attachments, delivery, skillDraft)}
    onAbort={() => abort(snapshot?.sessionId)}
    onCancelQueued={cancelQueued}
    onSteerQueued={steerQueued}
    onSetModel={(provider, id) => void setModel(provider, id)}
    onSetThinking={(level) => void setThinking(level)}
    runtimeChoice={runtimeChoice}
    onNewThreadOnRuntime={actions ? (kind, model) => {
      if (model) composer.carryModel?.(kind, model);
      preferences.setNewThreadRuntime(kind);
      // The new thread stays in this thread's project.
      const workspace = snapshot?.workspaceId ?? snapshot?.cwd;
      actions.newSession(workspace ? { workspace } : undefined);
    } : undefined}
    newThread={pendingNewThread}
    prompt={prompts[0]}
    promptsPending={Math.max(0, prompts.length - 1)}
    onAnswerPrompt={(value, typed, attachments) => {
      const active = prompts[0];
      if (active) answerUiPrompt(active.id, typeof value === "boolean" ? { confirmed: value } : typed ? { value, typed, ...(attachments?.length ? { attachments } : {}) } : { value });
    }}
    onCancelPrompt={() => {
      const active = prompts[0];
      if (active) answerUiPrompt(active.id, { cancelled: true });
    }}
    onCompactContext={() => void compactContext()}
    held={holds > 0}
    onNotify={onNotify}
    onOpenPromptEditor={() => void actions?.executeCommand?.("workspace.open-prompt-editor")}
    onRunShellAction={(cmd, includeInContext = true) => actions ? actions.runShellAction(cmd, includeInContext) : Promise.reject(new Error("Actions unavailable"))}
  />;
}
