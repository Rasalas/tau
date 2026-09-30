import { lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ListTree, MessageSquare } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiProject, UiToolOutputPreview, UiToolRun, UiThreadTree } from "../shared/contracts";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { StageState } from "../workbench/stage";
import type { StageTabController } from "./stage-tab-controller";
import type { ComposerAttachmentHandle, ComposerControlHandle, SubmitResult } from "./components/Composer";
import { Composer } from "./components/Composer";
import type { ComposerScopeStore } from "../workbench/composer-scope-store";
import type { UiQueuedMessage } from "../shared/contracts";
import { LazyFeatureBoundary, LazyFeatureFallback, retryableLazy } from "./components/LazyFeature";
import { ComposerHost, LiveStatus } from "./components/ComposerHost";
import { ComposerReserve } from "./components/ComposerReserve";
import { retryPrompt, TurnErrorLine } from "./components/TurnError";
import { useThreadShell } from "./use-thread-shell";
import { declareRuntimeMarks } from "./runtime-marks";
import { PairingRequestWatcher, QueuedMessages } from "./deferred-surfaces";
import { ToastLayer } from "./components/ui/ToastLayer";
import { TooltipLayer, tooltipProps } from "./components/ui/Tooltip";
import { ContextMenuLayer } from "./components/ui/ContextMenu";
import type { ToastStore } from "../workbench/toast-store";
import { Region, StatusLine } from "./components/Regions";
import { HostConnectionStatus } from "./host-connection-status";
import { COMPACT_SIDEBAR_MIN_WIDTH, compactSidebarMaxWidth, compactSidebarWidth, rendersOnProfile, type ClientProfile } from "../workbench/client-profile";
import { useCompactForm } from "./use-layout-profile";
import { useClientEnvironment } from "./client-environment";
import { coreThreadMenu, ThreadTitleMenu } from "./components/ThreadTitleMenu";
import type { ThreadTreeMode } from "./components/ThreadTreeModal";
import { TitleBar } from "./components/TitleBar";
import { ThreadRuntimeBanner } from "./components/ThreadRuntimeBanner";
import { TranscriptHistoryBoundary } from "./components/TranscriptHistoryBoundary";
import { TranscriptViewport } from "./components/TranscriptViewport";
import { JumpToLatestButton, JumpToLatestStore } from "./components/JumpToLatest";
import { TaskPill } from "./components/TaskProgress";
import { useConversationActivities } from "./conversation-activities";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { MountedPanel, PanelMaximizeButton, PanelSlot, usePanelHosts } from "./components/PanelHosts";
import { StartDetails, ThreadDetails, ThreadHeader } from "./components/ThreadHeader";
import { ProjectIcon } from "./components/ProjectIcon";
import { WindowControlsInset } from "./components/WindowControlsInset";
import { useHostClient } from "./host-client-context";
import { ResizeHandle } from "./components/ResizeHandle";
import type { PanelLayout } from "./use-panel-layout";
import type { NewThreadPick } from "./use-app-overlays";
import { panelTabId } from "../workbench/stage";
import { useCenterLayout } from "./use-center-layout";
import { CHAT_MIN_WIDTH } from "../workbench/center-layout";
import {
  CHAT_MAXIMIZE_OVERDRAG, DRAWER_DEFAULT_HEIGHT, DRAWER_MIN_HEIGHT, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH,
  chatMaxWidth, defaultChatWidth, drawerMaxHeight, shownChatWidth, shownDrawerHeight, shownSidebarWidth, sidebarMaxWidth,
  storedChatWidth, storedDrawerHeight, storedSidebarWidth,
} from "../workbench/layout-sizes";
import { useClientStorage } from "./client-storage-context";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { usePreferences } from "./renderer-services-context";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { threadListOrder } from "../workbench/thread-supervision";
import { useHostCapabilities, useHostName } from "./use-host-capabilities";
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
import { usePhoneNavigation } from "./use-phone-navigation";
import type { ShowThreadOptions } from "./use-thread-navigation";
import { phoneTab } from "../workbench/phone-route";
import { THREAD_DROP_FEEDBACK } from "../shared/thread-drop";

const LazyCommandPalette = retryableLazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const LazyLimitNotice = lazy(() => import("./components/LimitNotice").then(({ LimitNotice }) => ({ default: LimitNotice })));
const LazyStage = retryableLazy(() => import("./components/Stage").then(({ Stage }) => ({ default: Stage })));
// Drawn only beside the stage, so they come with its chunk.
const LazyStageTools = retryableLazy(() => import("./components/Stage").then(({ StageTools }) => ({ default: StageTools })));
const LazyAppPageScreen = retryableLazy(() => import("./pages/AppPageScreen").then(({ AppPageScreen }) => ({ default: AppPageScreen })));
const LazyPageSidebar = retryableLazy(() => import("./pages/AppPageScreen").then(({ PageSidebar }) => ({ default: PageSidebar })));
const LazySettingsScreen = retryableLazy(() => import("./settings/SettingsScreen").then(({ SettingsScreen }) => ({ default: SettingsScreen })));
// Modals a command opens; they stay out of the first paint.
const LazyThreadTreeModal = lazy(() => import("./components/ThreadTreeModal").then(({ ThreadTreeModal }) => ({ default: ThreadTreeModal })));
const LazyProjectSourcesModal = lazy(() => import("./components/ProjectSources").then(({ ProjectSourcesModal }) => ({ default: ProjectSourcesModal })));
const LazySystemPromptModal = lazy(() => import("./components/SystemPromptModal").then(({ SystemPromptModal }) => ({ default: SystemPromptModal })));
// The touch layout's own pieces: none of them is in a desktop window's first paint.
const LazyTouchLayer = lazy(() => import("./touch/TouchLayer").then(({ TouchLayer }) => ({ default: TouchLayer })));
const LazyTouchThreadBrowser = lazy(() => import("./touch/TouchThreadBrowser").then(({ TouchThreadBrowser }) => ({ default: TouchThreadBrowser })));
const LazyPhoneNav = lazy(() => import("./touch/PhoneNav").then(({ RegistryPhoneNav }) => ({ default: RegistryPhoneNav })));
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
  /** A thread was picked: the chat takes the front of a tabbed centre, and a compact client drops its panel sheet. */
  showThread(options?: ShowThreadOptions): void;
  /** Whether something covers the thread, and on a compact client the order of its thread list. */
  threadView(): { covered: boolean; listOrder?: readonly string[] };
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
  /** The project the stage is stored for: its workspace id, or its path where the host mints none. */
  stageWorkspace?: string;
  sidebarContributions: ReturnType<ExtensionRegistry["getSidebarContributions"]>;
  panels: ReturnType<ExtensionRegistry["getPanels"]>;
  activePanel: string;
  openPanel(id: string): void;
  /** Which panels are on the stage, and the moves between drawer and stage. */
  panelLayout?: PanelLayout;
  /** The drawer panel showing below the conversation. */
  drawer?: string;
  /** The user hid the thread's stage. */
  stageFolded: boolean;
  setStageFolded(folded: boolean): void;
  /** The stage fills the centre, the conversation out of sight. */
  maximized: boolean;
  /** Where only one of the two is shown: the conversation rather than the stage. */
  chatFocused: boolean;
  setChatFocused(focused: boolean): void;
  /** The stage over the whole centre; cleared when the stage closes. */
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
  paletteOpen: boolean;
  /** The command whose level the palette opens on. */
  paletteMenu?: string;
  closePalette(): void;
  commands: ReturnType<ExtensionRegistry["getCommands"]>;
  projectSourcesOpen: boolean;
  /** The source the project sources open on. */
  projectSource?: string;
  closeProjectSources(): void;
  newThreadPick?: NewThreadPick | undefined;
  openNewThreadPicker(pick?: NewThreadPick): void;
  closeNewThreadPicker(): void;
  projects: readonly UiProject[];
  removeProject(project: UiProject): void;
  /** `carry` moves the draft on screen to the project instead of leaving it in the list. */
  createThreadInProject(project: UiProject, options?: { carry?: boolean }): void;
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
  /** The runtime the draft on screen is bound to, when not the preference for new threads. */
  draftRuntime?: string | undefined;
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
  /** The next draft starts on this runtime, and on its `model` when given. */
  carryModel?(runtime: string, model?: import("../shared/contracts").UiModel): void;
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
    registry, threadStore, settings, layoutProfile, workspaceCwd, stageWorkspace, sidebarContributions: allSidebarContributions, panels: allPanels, activePanel,
    openPanel, panelLayout, drawer, stageFolded, setStageFolded,
    chatFocused, setChatFocused, maximized, setStageMaximized, stage, stageTabs, activateStageTab, pinStageTab, unpinStageTab, setStageFileView,
    loadThread, takeOverThread,
    documentState, documentSource, paletteOpen, paletteMenu, closePalette, commands,
    projectSourcesOpen, projectSource, closeProjectSources, newThreadPick, openNewThreadPicker, closeNewThreadPicker,
    projects, removeProject, createThreadInProject, settingsPage, setSettingsPage,
    setNotice, activeOverlayId, closeOverlay, pages,
  } = layout;
  const {
    snapshot, conversationSnapshot, pendingNewThread, draftRuntime, showStartScreen, startProjectPath, startProjectName,
    dropController, activeDraftKey, titleCommands, openThreadTree, duplicateThread, settleActiveThread,
    renameThread, copyThreadValue, threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  } = thread;
  const {
    setModel, setThinking,
  } = composer;
  const clientStorage = useClientStorage();
  const preferences = usePreferences();
  const hostCapabilities = useHostCapabilities();
  const hostName = useHostName();
  // A draft's stage reads its own project, not the one the host has open.
  const loadStageFile = useCallback(
    (path: string) => documentSource ? documentSource.loadFile(path, { workspace: stageWorkspace }) : loadFileUnavailable(path),
    [documentSource, stageWorkspace],
  );
  const loadStageDiff = useCallback(
    (path: string, options?: DiffLoadOptions) => documentSource ? documentSource.loadDiff(path, options, { workspace: stageWorkspace }) : loadDiffUnavailable(path),
    [documentSource, stageWorkspace],
  );
  const platform = usePlatform();
  // Sidebar width and drawer height belong to this client, not to a workspace.
  const windowWidth = useSyncExternalStore(subscribeToViewport, viewportWidth);
  const windowHeight = useSyncExternalStore(subscribeToViewport, viewportHeight);
  const [sidebarWidth, setSidebarWidthState] = useState(() => storedSidebarWidth(clientStorage.get(STORAGE_KEYS.sidebarWidth)));
  const [sidebarWidthChosen, setSidebarWidthChosen] = useState(() => Boolean(clientStorage.get(STORAGE_KEYS.sidebarWidth)));
  const setSidebarWidth = (width: number) => {
    setSidebarWidthChosen(true);
    setSidebarWidthState(width);
    clientStorage.set(STORAGE_KEYS.sidebarWidth, String(width));
  };
  const [drawerHeight, setDrawerHeightState] = useState(() => storedDrawerHeight(clientStorage.get(STORAGE_KEYS.drawerHeight)));
  const setDrawerHeight = (height: number) => {
    setDrawerHeightState(height);
    clientStorage.set(STORAGE_KEYS.drawerHeight, String(height));
  };
  const [chatWidthPreference, setChatWidthPreference] = useState(() => storedChatWidth(clientStorage.get(STORAGE_KEYS.chatWidth)));
  // Parked where it stays visible while the conversation is folded: its layers must not hide with it.
  const [titleActionsHost] = useState(() => { const host = document.createElement("div"); host.className = "panel-host"; return host; });
  // One screen wide: the thread list is a screen of its own and the stage has nowhere to go.
  // The registry still holds those contributions; only this layout leaves them out.
  const compact = layoutProfile === "compact";
  // A tablet gets the desktop's arrangement: list, chat, tools and documents beside it, a rail.
  const clientProfile = useClientEnvironment().profile;
  const compactForm = useCompactForm(clientProfile);
  const split = compact && compactForm === "split";
  const compactRef = useRef({ compact, split, stacked: false, maximized: false, sheets: [] as readonly string[] });
  compactRef.current = { ...compactRef.current, compact, split };
  const [touchSidebarOpen, setTouchSidebarOpen] = useState(true);
  // The project the touch thread list is narrowed to; a new thread from it starts there.
  const [touchProjectPath, setTouchProjectPath] = useState<string>();
  const touchProject = touchProjectPath === undefined ? undefined : projects.find((project) => project.path === touchProjectPath);
  // A phone's home is its thread list; a chat, a page or Settings is a screen over it.
  const phone = compact && !split;
  const phoneNav = usePhoneNavigation({ phone, pages, settingsPage, setSettingsPage, sessionId: snapshot?.sessionId, drafting: pendingNewThread });
  const phoneHome = phone && !phoneNav.chatShown;
  // Back to a phone's list from a draft nobody wrote in closes it; one with something in it stays a row.
  useEffect(() => {
    const draft = phoneHome ? threadStore.getDrafts().find((candidate) => candidate.active) : undefined;
    if (draft && !draft.preview && draft.attachments === 0) actions.discardDraft?.(draft.draftId);
  }, [phoneHome]);
  // On a compact layout a panel that claims `compact` opens over the thread; F10 and F11 add theirs here.
  const [panelSheet, setPanelSheet] = useState<string>();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(() => clientStorage.get(STORAGE_KEYS.sidebarOpen) !== "false");
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [jumpToLatest] = useState(() => new JumpToLatestStore());
  const openPage = useSyncExternalStore(pages.subscribe, pages.getSnapshot);
  // A phone shows a page as a screen of its own; elsewhere it takes the thread's place beside the sidebar.
  const pageScreen = compact && !split;
  useCloseOnThreadChange(pages, snapshot?.sessionId, pendingNewThread);
  const threadViewRef = useRef({ covered: false, project: touchProject });
  threadViewRef.current = { covered: phoneHome || Boolean(settingsPage || openPage || activeOverlayId), project: touchProject };
  const stageRef = useRef<HTMLElement>(null);
  const projectPill = useRef<HTMLButtonElement>(null);
  useImperativeHandle(layout.controlRef, () => ({
    openInstructions: () => setSystemPromptOpen(true),
    focusStage: () => stageRef.current?.focus(),
    toggleSidebar: () => {
      if (compactRef.current.split) { setTouchSidebarOpen((open) => !open); return; }
      if (compactRef.current.compact) { phoneNav.toggleChat(); return; }
      setSidebarOpen((open) => {
        clientStorage.set(STORAGE_KEYS.sidebarOpen, String(!open));
        return !open;
      });
    },
    openSheet: (id) => {
      if (!compactRef.current.sheets.includes(id)) return false;
      setPanelSheet(id);
      return true;
    },
    closeSheet: (id) => {
      if (!compactRef.current.sheets.includes(id)) return false;
      setPanelSheet((open) => (open === id ? undefined : open));
      return true;
    },
    showThread: (options) => {
      setPanelSheet(undefined);
      phoneNav.showChat();
      // Beside the stage the chat is already in view. A maximized stage makes room for it again, beside it.
      if (compactRef.current.maximized) setStageMaximized(false);
      if (compactRef.current.stacked) setChatFocused(true);
      if (options?.focusComposer) setComposerFocusRequest((count) => count + 1);
    },
    threadView: () => {
      const { covered, project } = threadViewRef.current;
      if (!compactRef.current.compact) return { covered };
      // Settled threads keep their unsettled rank: one settling right now still has its place.
      const { threads } = threadStore.getSnapshot();
      return { covered, listOrder: threadListOrder(threads, threadStore.getActivity(), { pinned: preferences.getSnapshot().pinnedThreadIds, ...(project ? { project } : {}) }) };
    },
  }), [clientStorage, phoneNav.showChat, phoneNav.toggleChat, preferences, setChatFocused, threadStore]);
  // After the commit that shows the chat: a hidden tab's composer cannot take focus.
  useEffect(() => {
    if (composerFocusRequest > 0) composer.textareaRef.current?.focus();
  }, [composer.textareaRef, composerFocusRequest]);
  const sidebarContributions = compact ? EMPTY_CONTRIBUTIONS : allSidebarContributions;
  // A tablet draws the stage beside the chat, as a desktop does; a phone opens panels as sheets.
  const panels = compact && !split ? EMPTY_CONTRIBUTIONS : allPanels;
  const sheetPanels = useMemo(() => phone ? allPanels.filter((panel) => rendersOnProfile(panel.profiles, "compact")) : EMPTY_CONTRIBUTIONS, [allPanels, phone]);
  const sheetPanel = sheetPanels.find((panel) => panel.id === panelSheet);
  compactRef.current.sheets = sheetPanels.map((panel) => panel.id);
  const drawerPanels = useMemo(() => panels.filter((panel) => panel.placement === "drawer"), [panels]);
  const staged = panelLayout?.staged ?? EMPTY_STAGED;
  const drawerPanel = drawerPanels.find((panel) => panel.id === drawer && !staged.has(panel.id));
  const hostFor = usePanelHosts();
  const maximizeShortcut = registry.keybindingLabel?.("rightPanel.toggleMaximized");
  const sidebarShown = sidebarOpen && sidebarContributions.length > 0;
  const shownSidebar = sidebarShown ? shownSidebarWidth(sidebarWidth, windowWidth) : 0;
  const touchSidebarShown = split && touchSidebarOpen;
  // A page with a sidebar of its own draws it in the thread list's place, on a desktop.
  const pageSidebar = Boolean(openPage && sidebarShown && !compact && registry.getPage(openPage.id)?.Sidebar);
  const drawnSidebar = split ? (touchSidebarShown ? compactSidebarWidth(windowWidth, sidebarWidthChosen ? sidebarWidth : undefined) : 0) : shownSidebar;
  const clearStageMaximized = useCallback(() => setStageMaximized(false), [setStageMaximized]);
  // A phone draws no stage (profile-compact.css): its panels are sheets.
  const { stageShown, tabs, canSplit } = useCenterLayout({
    windowWidth, sidebarWidth: drawnSidebar, stageOpen: stage.tabs.length > 0 && !phone, folded: stageFolded, maximized,
    tabCount: stage.tabs.length, clearMaximized: clearStageMaximized,
  });
  // Maximized, the stage takes the centre and the chat is out of sight; where only one fits, the one in front shows.
  const stacked = tabs;
  compactRef.current.stacked = stacked;
  compactRef.current.maximized = maximized;
  const conversationFolded = stacked && (maximized || !chatFocused);
  const stageExpanded = stageShown && !(stacked && !maximized && chatFocused);
  const sideOpen = stageShown && !stacked;
  const centerWidth = windowWidth - drawnSidebar;
  const chatWidth = shownChatWidth(chatWidthPreference, centerWidth);
  // Opening another thread (from a panel, say) puts the thread in front again.
  useEffect(() => { setPanelSheet(undefined); }, [compact, snapshot?.sessionId]);

  const setChatWidth = (width: number) => {
    // Dragged well past the chat's minimum: the stage takes the whole centre.
    if (width <= CHAT_MIN_WIDTH - CHAT_MAXIMIZE_OVERDRAG) {
      panelLayout?.maximizeStage();
      return;
    }
    const bounded = Math.max(CHAT_MIN_WIDTH, width);
    setChatWidthPreference(bounded);
    clientStorage.set(STORAGE_KEYS.chatWidth, String(bounded));
  };
  // The header's toggle hides the stage or brings it back; an empty one opens the tool last picked in the project, else Files.
  const firstTool = panels.find((panel) => panel.id === activePanel && panel.placement !== "drawer")
    ?? panels.find((panel) => panel.stageButton && panel.placement !== "drawer") ?? panels.find((panel) => panel.placement !== "drawer");
  const toggleStage = () => {
    if (stage.tabs.length === 0) { if (firstTool) openPanel(firstTool.id); return; }
    if (stageExpanded) { setStageFolded(true); return; }
    setStageFolded(false);
    setChatFocused(false);
  };
  // The tools' buttons read as pressed while their tab is in front of a shown stage, or their drawer is open.
  const frontTab = stage.tabs.find((tab) => tab.id === stage.activeId);
  const shownTools = useMemo(() => new Set([
    ...(stageExpanded && frontTab?.kind === "panel" ? [frontTab.panelId] : []),
    ...(drawerPanel ? [drawerPanel.id] : []),
  ]), [drawerPanel, frontTab, stageExpanded]);
  const openedTools = useMemo(() => new Set([
    ...stage.tabs.flatMap((tab) => tab.kind === "panel" ? [tab.panelId] : []),
    ...(drawerPanel ? [drawerPanel.id] : []),
  ]), [drawerPanel, stage.tabs]);
  const openTool = (id: string) => {
    if (drawerPanel?.id === id) { actions.closePanel?.(id); return; }
    if (split && stageExpanded && frontTab?.kind === "panel" && frontTab.panelId === id) { setStageFolded(true); return; }
    openPanel(id);
  };
  const stageTools = <>
    <Suspense fallback={null}><LazyStageTools panels={panels} shown={shownTools} opened={split ? openedTools : undefined} onOpen={openTool} /></Suspense>
    <Region registry={registry} placement="stage-bar" snapshot={snapshot} actions={actions} />
  </>;

  // macOS draws its traffic lights over the window's top left; elsewhere the OS frames the window itself.
  const macInset = useHostClient()?.platform === "darwin" && !compact;
  const centerClassName = [
    "workbench-center",
    sideOpen ? "stage-open" : "",
    stageExpanded && stacked ? "stage-full" : "",
    conversationFolded ? "conversation-folded" : "",
  ].filter(Boolean).join(" ");
  const shellClassName = [
    "app-shell",
    split ? "touch-split" : "",
    sidebarContributions.length === 0 && !split ? "no-sidebar" : "",
    (split ? touchSidebarOpen : sidebarOpen) ? "" : "sidebar-closed",
    macInset ? "window-inset" : "",
  ].filter(Boolean).join(" ");

  const openSupervisedThread = (row: { path: string }) => { void actions.switchSession(row.path); };
  // As ⌘N, with the filtered project first.
  const startTouchThread = () => actions.newSession(touchProject ? { workspace: touchProject.workspaceId ?? touchProject.path, pick: true } : undefined);
  const threadBrowserProps = {
    registry,
    actions,
    onOpen: openSupervisedThread,
    onStop: (row: { id: string }) => composer.abort(row.id),
    project: touchProject,
    projects,
    onProjectChange: (project: UiProject | undefined) => setTouchProjectPath(project?.path),
    onNewThread: startTouchThread,
    onOpenSettings: (page?: string) => (phone ? phoneNav.openSettings(page) : actions.openSettings(page)),
  };
  // The bottom navigation, drawn by each main page as its last row.
  const bottomNav = phone ? <Suspense fallback={null}>
    <LazyPhoneNav registry={registry} current={phoneTab(phoneNav.route)} onSelect={phoneNav.openTab} />
  </Suspense> : undefined;

  const detailSlots = useMemo(() => ({ registry, actions }), [registry, actions]);
  const conversationComposer = <ConversationComposer
    view={view}
    composer={composer}
    snapshot={snapshot}
    conversationSnapshot={conversationSnapshot}
    pendingNewThread={pendingNewThread}
    draftRuntime={draftRuntime}
    activeDraftKey={activeDraftKey}
    onNotify={actions.notify}
    actions={actions}
  />;

  // The frame goes around the card too: bare, it would fall into the shell grid's next free cell.
  const pageFrame = (content: React.ReactNode) => <section className={`app-page${pageScreen ? " stacked" : ""}`}>{content}</section>;
  const appPage = openPage ? <LazyFeatureBoundary label="page" title="This page failed to load." frame={pageFrame} onClose={pages.close}>
    <Suspense fallback={pageFrame(<LazyFeatureFallback label="page" />)}>
      <LazyAppPageScreen registry={registry} store={pages} actions={actions} stacked={pageScreen} sidebarShown={split ? touchSidebarShown : sidebarShown} pageSidebar={pageSidebar} nav={bottomNav} />
    </Suspense>
  </LazyFeatureBoundary> : null;

  const pageSidebarFrame = (content: React.ReactNode) => <aside className="page-sidebar-frame">{content}</aside>;
  const settingsFrame = (content: React.ReactNode) => <div className="settings-screen loading">{content}</div>;
  const overlays = <>
    {compact ? <Suspense fallback={null}><LazyTouchLayer
      syncUrl={clientProfile !== "desktop"}
      openThread={actions.switchSession}
      {...(phone ? { phone: { route: phoneNav.route, onRoute: phoneNav.applyRoute } } : {})}
    /></Suspense> : null}
    {phoneHome ? <Suspense fallback={null}>
      {/* Under a page or Settings the list stays mounted, keeping its scroll; the bar is the covering page's. */}
      <LazyTouchThreadBrowser variant="home" {...threadBrowserProps} nav={phoneNav.route.kind === "threads" ? bottomNav : undefined} />
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
    <LazyFeatureBoundary label="command palette" frame={(content) => paletteOpen ? <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}><div className="lazy-feature-dialog">{content}</div></div> : null} onClose={closePalette}>
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
        open={newThreadPick !== undefined}
        projects={projects}
        threads={threadStore.getSnapshot().threads}
        preselect={newThreadPick?.preselect}
        machine={hostName}
        sheet={compact}
        anchor={newThreadPick?.anchor}
        {...(newThreadPick?.carry ? { heading: "Project" } : {})}
        onBrowse={() => actions.openProjectSources()}
        onClose={closeNewThreadPicker}
        onRemove={removeProject}
        onSelect={(project) => { closeNewThreadPicker(); createThreadInProject(project, newThreadPick?.carry ? { carry: true } : undefined); }}
      />
    </Suspense>
    {openPage && pageScreen ? appPage : null}
    {settingsPage ? <LazyFeatureBoundary label="settings" title="Settings failed to load." frame={settingsFrame} onClose={() => setSettingsPage(undefined)}>
      <Suspense fallback={settingsFrame(<LazyFeatureFallback label="settings" />)}>
        <LazySettingsScreen
          page={settingsPage}
          stacked={compact && !split}
          {...(phone ? { view: phoneNav.settingsView, onViewChange: phoneNav.setSettingsView, nav: bottomNav } : {})}
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
  const overlayFrame = (content: React.ReactNode) => <div className="lazy-feature-screen">{content}</div>;
  const providers = (content: React.ReactNode) => <WorkbenchProviders model={model} threadStore={threadStore}>{content}</WorkbenchProviders>;
  if (activeOverlay) return providers(<>
    <LazyFeatureBoundary
      label={activeOverlay.id}
      extensionId={activeOverlay.extensionId}
      extensionName={activeOverlay.extensionName}
      registry={registry}
      onNotify={actions.notify}
      onClose={closeOverlay}
      frame={overlayFrame}
    >
      <Suspense fallback={overlayFrame(<LazyFeatureFallback label={activeOverlay.id} />)}>
        <activeOverlay.Component actions={actions} onClose={closeOverlay} />
      </Suspense>
    </LazyFeatureBoundary>
    {overlays}
    {floats}
  </>);

  const stageFrame = (content: React.ReactNode) => <section className="stage">{content}</section>;
  const startProject = showStartScreen ? projects.find((project) => project.path === startProjectPath) : undefined;
  const threadTitle = showStartScreen ? <span className="title-draft">New thread</span> : <>
          <Region registry={registry} placement="thread-title" snapshot={snapshot} actions={actions} />
          <ThreadTitleMenu
            title={conversationSnapshot?.sessionTitle || "Untitled thread"}
            onRename={renameThread}
            menu={() => {
              const id = snapshot?.sessionId;
              const session = threadStore.getSnapshot().threads.find((entry) => entry.id === id);
              const provider = registry.getThreadMenu();
              const sections = session && provider?.menu(session, registry);
              return sections ? { sections, run: (item) => provider!.run(session!, item, actions) } : coreThreadMenu({
                label: snapshot?.projectLabel,
                pinned: Boolean(id && settings.pinnedThreadIds.includes(id)),
                settled: Boolean(id && settings.settledThreadIds.includes(id)),
                readOnly: hostCapabilities.readOnly,
                commands: titleCommands,
                canCopyPath: hostCapabilities.localFiles,
                run: (item) => {
                  if (item === "new") actions.newSession();
                  if (item === "tree") openThreadTree("navigate");
                  if (item === "instructions") setSystemPromptOpen(true);
                  if (item === "duplicate") void duplicateThread();
                  if (item === "pin" && id) preferences.togglePinned(id);
                  if (item === "settle") settleActiveThread();
                  if (item === "unread" && id) threadStore.markUnread(id);
                  if (item.startsWith("copy-")) void copyThreadValue(item.slice(5) as "chat" | "path" | "thread-id");
                  if (item.startsWith("command:")) void titleCommands.find((command) => `command:${command.id}` === item)?.run(actions);
                },
              });
            }}
          />
        </>;
  // The conversation's head replaces the window-wide bar everywhere but on a phone, whose bar is its own.
  const conversationHeader = phone ? null : <ThreadHeader
    lead={<>
      {sidebarShown && !split ? null : <WindowControlsInset />}
      {split ? <button type="button" className="stage-tool" aria-label="Threads" {...tooltipProps("Threads", { side: "bottom" })} onClick={() => setTouchSidebarOpen((open) => !open)}><ListTree size={16} /></button> : null}
    </>}
    title={threadTitle}
    // A draft's pills say project, machine and branch; an empty thread's branch has no pill.
    details={!showStartScreen && !split ? <ThreadDetails snapshot={conversationSnapshot} view={view} slots={detailSlots} />
      : pendingNewThread ? undefined : <StartDetails snapshot={conversationSnapshot} slots={detailSlots} />}
    actions={conversationFolded ? null : <PanelSlot host={titleActionsHost} />}
    tools={stageExpanded ? undefined : stageTools}
    {...(!split && (firstTool || stage.tabs.length > 0) ? { stage: { shown: stageExpanded, shortcut: registry.keybindingLabel?.("workbench.toggle-dock"), onToggle: toggleStage } } : {})}
  />;
  return providers(<>
    {/* Settings covers the shell rather than unmounting it, so threads, terminals and scroll stay as they were. */}
    <div className={shellClassName} inert={Boolean(settingsPage) || phoneHome} style={{ "--sidebar-width": `${drawnSidebar}px` } as CSSProperties}>
      {phone ? <TitleBar
        registry={registry}
        snapshot={snapshot}
        actions={actions}
        thread={threadTitle}
        details={showStartScreen ? undefined : <ThreadDetails snapshot={conversationSnapshot} view={view} machine={hostName} />}
        onBack={phoneNav.showList}
        foldSheets
        sheets={sheetPanels.map((panel) => ({
          id: panel.id,
          label: panel.label,
          Icon: panel.Icon,
          open: panelSheet === panel.id,
          ...(panel.stageButton ? { pinned: true } : {}),
          onToggle: () => setPanelSheet((open) => (open === panel.id ? undefined : panel.id)),
        }))}
      /> : null}
      {macInset && sidebarShown ? <div className="sidebar-top" aria-hidden /> : null}
      {split ? <div className="sidebar-slot">
        <Suspense fallback={<aside className="touch-browser sidebar" />}><LazyTouchThreadBrowser variant="sidebar" {...threadBrowserProps} /></Suspense>
      </div> : null}
      {pageSidebar ? <div className="sidebar-slot"><LazyFeatureBoundary label="sidebar" frame={pageSidebarFrame}>
        <Suspense fallback={pageSidebarFrame(null)}><LazyPageSidebar registry={registry} store={pages} actions={actions} /></Suspense>
      </LazyFeatureBoundary></div> : null}
      <div className={pageSidebar ? "sidebar-slot covered" : "sidebar-slot"}>{sidebarContributions.map((contribution) => <LazyFeatureBoundary
        key={contribution.id}
        label="sidebar"
        extensionId={contribution.extensionId}
        extensionName={contribution.extensionName}
        registry={registry}
        onNotify={actions.notify}
      >
        <Suspense fallback={<LazyFeatureFallback label="sidebar" />}><contribution.Component actions={actions} /></Suspense>
      </LazyFeatureBoundary>)}</div>
      {touchSidebarShown || (sidebarShown && !compact) ? <ResizeHandle
        className="sidebar-resizer"
        label="Resize sidebar"
        orientation="vertical"
        grows="right"
        value={drawnSidebar}
        min={split ? COMPACT_SIDEBAR_MIN_WIDTH : SIDEBAR_MIN_WIDTH}
        max={split ? compactSidebarMaxWidth(windowWidth) : sidebarMaxWidth(windowWidth)}
        defaultValue={split ? compactSidebarWidth(windowWidth) : SIDEBAR_DEFAULT_WIDTH}
        onChange={setSidebarWidth}
      /> : null}
      <div className="workbench-main" inert={Boolean(openPage) && !pageScreen}>
      <div className={centerClassName} style={{ "--chat-width": `${chatWidth}px` } as CSSProperties}>
        <main
          className={`conversation-column ${showStartScreen ? "conversation-start" : ""}`}
          data-keybinding-context="chat"
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
          {/* Before the composer in the DOM: the dock paints over the transcript by tree order. */}
          {conversationHeader}
          <div className="conversation-thread">
            {!showStartScreen ? <>
              <Region registry={registry} placement="transcript-header" snapshot={snapshot} actions={actions} />
              {snapshot?.sessionId ? <ThreadRuntimeBanner
                sessionId={snapshot.sessionId}
                onRetry={(path) => void actions.switchSession(path)}
                onOpenProviders={() => (phone ? phoneNav.openSettings("providers") : actions.openSettings("providers"))}
              /> : null}
              <ConversationTranscript view={view} thread={thread} registry={registry} actions={actions} prompts={composer.prompts} abort={composer.abort} composer={composer} jumpToLatest={jumpToLatest} />
              {/* On the transcript's bottom edge, so a floating Jump to latest never covers the footer. */}
              <Region
                registry={registry}
                placement="composer-controls"
                snapshot={snapshot}
                actions={actions}
                lead={conversationSnapshot?.taskProgress ? <TaskPill progress={conversationSnapshot.taskProgress} /> : undefined}
              >
                <JumpToLatestButton store={jumpToLatest} onKeyboardJump={() => actions.focusComposer()} />
              </Region>
              <Region registry={registry} placement="transcript-footer" snapshot={snapshot} actions={actions} />
              <ComposerReserve />
            </> : null}
          </div>
          <section className="conversation-start-screen" aria-labelledby={showStartScreen ? "start-screen-title" : undefined}>
            <div className="conversation-start-content">
              {showStartScreen ? <div className="conversation-empty">
                <i aria-hidden><MessageSquare size={20} /></i>
                <h1 id="start-screen-title">What should {startProjectName} do next?</h1>
                <p>Just chat, or hand it work. Files, Terminal and your editor sit top right.</p>
                <Region registry={registry} placement="draft-actions" snapshot={snapshot} actions={actions} lead={<button
                  ref={projectPill}
                  type="button"
                  className="draft-pill"
                  aria-label={`Change project, current project ${startProjectName}`}
                  aria-haspopup="dialog"
                  aria-expanded={newThreadPick?.anchor === projectPill}
                  {...tooltipProps(displayPath(startProjectPath), { variant: "code" })}
                  // The popover ignores a press on its anchor, so this click closes what it opened.
                  onClick={() => newThreadPick?.anchor === projectPill
                    ? closeNewThreadPicker()
                    : openNewThreadPicker({ carry: true, preselect: startProjectPath, ...(compact ? {} : { anchor: projectPill }) })}
                >
                  <ProjectIcon project={startProject ?? { path: startProjectPath, name: startProjectName }} />
                  <span>{startProjectName}</span><ChevronDown size={12} />
                </button>} />
              </div> : null}
              <Region registry={registry} placement="composer-above" snapshot={snapshot} actions={actions} />
              <ComposerHost start={showStartScreen}>{conversationComposer}</ComposerHost>
              <Region registry={registry} placement="composer-below" snapshot={snapshot} actions={actions} />
            </div>
          </section>
          <HostConnectionStatus />
          <StatusLine registry={registry} snapshot={snapshot} actions={actions} />
        </main>
        {sideOpen ? <ResizeHandle
          className="chat-resizer"
          label="Resize chat"
          orientation="vertical"
          grows="right"
          value={chatWidth}
          min={CHAT_MIN_WIDTH - CHAT_MAXIMIZE_OVERDRAG}
          max={chatMaxWidth(centerWidth)}
          defaultValue={defaultChatWidth(centerWidth)}
          onChange={setChatWidth}
        /> : null}
        {stageExpanded ? <LazyFeatureBoundary label="stage" title="The stage failed to load." frame={stageFrame}>
          <Suspense fallback={stageFrame(<LazyFeatureFallback label="stage" />)}>
            <LazyStage
              focusRef={stageRef}
              stage={stage}
              cwd={workspaceCwd}
              workspace={stageWorkspace}
              changes={documentState.changes}
              editor={documentState.editor}
              maximize={panelLayout && (canSplit || maximized) ? { maximized, onToggle: () => {
                setChatFocused(false);
                if (maximized) panelLayout.restore();
                else panelLayout.maximizeStage();
              } } : stacked ? { maximized: true, label: "Show chat", onToggle: () => setChatFocused(true) } : undefined}
              tools={stageTools}
              registry={registry}
              stageTabs={stageTabs}
              actions={actions}
              loadFile={loadStageFile}
              loadDiff={loadStageDiff}
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
                return panel ? <PanelSlot host={hostFor(panel.id)} /> : null;
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
      {conversationFolded ? <div className="title-actions-parked"><PanelSlot host={titleActionsHost} /></div> : null}
      {openPage && !pageScreen ? appPage : null}
    </div>
    {overlays}
    {floats}
    {sheetPanel ? createPortal(<MountedPanel
      Component={sheetPanel.Component}
      active
      placement="sheet"
      label={sheetPanel.label}
      extensionId={sheetPanel.extensionId}
      extensionName={sheetPanel.extensionName}
      registry={registry}
      actions={actions}
      onNotify={actions.notify}
    />, hostFor(sheetPanel.id), sheetPanel.id) : null}
    {!phone ? createPortal(<Region registry={registry} placement="title-bar" snapshot={snapshot} actions={actions} />, titleActionsHost) : null}
    {panels.map((panel) => {
      const onStage = staged.has(panel.id);
      // A panel lives as long as its tab or its drawer; a folded stage keeps it mounted, only hidden.
      if (!onStage && drawerPanel?.id !== panel.id) return null;
      const placement = onStage ? "stage" : "drawer";
      const active = onStage ? stage.activeId === panelTabId(panel.id) && stageExpanded : true;
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
  const runtimeBackends = model.shellContext.snapshot?.runtimeBackends;
  useEffect(() => declareRuntimeMarks(runtimeBackends), [runtimeBackends]);
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
function ConversationTranscript({ view, thread, registry, actions, prompts, abort, composer, jumpToLatest }: {
  view: ThreadViewStore;
  jumpToLatest: JumpToLatestStore;
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
  const { thinking, liveStatusLabel, transcriptActivities } = useConversationActivities({
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
      : thinking ? <LiveStatus startedAt={runStartedAt} />
      : limit && conversationSnapshot ? <Suspense fallback={null}><LazyLimitNotice sessionId={conversationSnapshot.sessionId} limit={limit} /></Suspense>
      : turnError ? <TurnErrorLine message={turnError} onRetry={readOnly ? undefined : () => retry()} /> : undefined;
    if (pendingNewThread || queue.length === 0) return status;
    return <>{status}<QueuedMessages queue={queue} streaming={running} held={queueHeld} steerShortcut={steerShortcut} onSteer={steerQueued} onReturn={returnQueued} onReorder={reorderQueue} /></>;
  }, [conversationSnapshot, limit, liveStatusLabel, pendingNewThread, queue, queueHeld, readOnly, reorderQueue, retry, returnQueued, runStartedAt, running, thinking, steerQueued, steerShortcut, turnError]);
  return <TranscriptHistoryBoundary
    controller={transcriptHistory}
    showControl={!pendingNewThread && messages.length > 0}
    loadPage={loadTranscriptPage}
    applyPage={applyTranscriptPage}
  >
    {(loadOlderOnReach, history) => <TranscriptViewport
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
      history={history}
      onReachStart={loadOlderOnReach}
      jumpToLatest={jumpToLatest}
    />}
  </TranscriptHistoryBoundary>;
}

/** The context meter reads the running token estimate, so the composer subscribes too. */
function ConversationComposer({ view, composer, snapshot, conversationSnapshot, pendingNewThread, draftRuntime, activeDraftKey, onNotify, actions, lead }: {
  view: ThreadViewStore;
  lead?: React.ReactNode;
  composer: WorkbenchComposer;
  snapshot?: HostSnapshot;
  conversationSnapshot?: HostSnapshot;
  pendingNewThread: boolean;
  draftRuntime?: string | undefined;
  activeDraftKey?: string;
  onNotify?(message: string): void;
  actions?: WorkbenchActions;
}) {
  const transcript = useSyncExternalStore(view.subscribeToTranscript, view.getTranscript);
  // Only at the meter's precision: tool output would otherwise re-render the composer every frame.
  const toolKiloTokens = useSyncExternalStore(view.subscribeToTools, () => toolOutputKiloTokens(view.getToolView().tools));
  const preferences = usePreferences();
  const { newThreadRuntime } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // The runtime is a property of the thread; it is chosen before the thread exists and never after.
  const runtimeBackends = snapshot?.runtimeBackends ?? [];
  const runtimeChoice = pendingNewThread && runtimeBackends.length > 1
    ? { kind: effectiveNewThreadRuntime(draftRuntime ?? newThreadRuntime, snapshot), backends: runtimeBackends, onSelect: (kind: string) => (composer.selectRuntime ? composer.selectRuntime(kind) : preferences.setNewThreadRuntime(kind)) }
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
      composer.carryModel?.(kind, model);
      preferences.setNewThreadRuntime(kind);
      // The new thread stays in this thread's project.
      const workspace = snapshot?.workspaceId ?? snapshot?.cwd;
      actions.newSession(workspace ? { workspace } : undefined);
    } : undefined}
    newThread={pendingNewThread}
    lead={lead}
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
