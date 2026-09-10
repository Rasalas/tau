import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type RefObject } from "react";
import { ChevronDown, Folder, X } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiProject, UiToolRun, UiThreadTree } from "../shared/contracts";
import type { UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { StageState } from "../workbench/stage";
import type { ComposerAttachmentHandle, SubmitResult } from "./components/Composer";
import { Composer } from "./components/Composer";
import type { ComposerScopeStore } from "../workbench/composer-scope-store";
import type { QueuedFollowUp } from "../workbench/follow-up-queue";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { ComposerHost, LiveStatus } from "./components/ComposerHost";
import { PanelIcon } from "./components/PanelIcon";
import { ProjectPicker } from "./components/ProjectPicker";
import { ProjectSourcesModal } from "./components/ProjectSources";
import { Region, StatusLine } from "./components/Regions";
import { HostConnectionStatus } from "./host-connection-status";
import { ThreadSupervisor } from "./components/ThreadSupervisor";
import type { ClientProfile } from "../workbench/client-profile";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
import { ThreadTreeModal, type ThreadTreeMode } from "./components/ThreadTreeModal";
import { SystemPromptModal } from "./components/SystemPromptModal";
import { TitleBar } from "./components/TitleBar";
import { TranscriptHistoryBoundary } from "./components/TranscriptHistoryBoundary";
import { TranscriptViewport } from "./components/TranscriptViewport";
import type { TranscriptActivity } from "./components/transcript-activity";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import type { ExtensionRegistry, PanelProps, WorkbenchActions } from "./extension-system";
import { useClientStorage } from "./client-storage-context";
import type { ClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { usePreferences } from "./renderer-services-context";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { publishStageBand } from "./reserved-region";
import { useHostCapabilities } from "./use-host-capabilities";
import { usePlatform } from "./platform-context";
import type { PreferencesState } from "./preferences";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import { contextBreakdownFor, conversationMessagesFor } from "../workbench/app-state";
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

const CENTER_SPLIT_MIN_WIDTH = 480 + 360;
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
const LazyStage = lazy(() => import("./components/Stage").then(({ Stage }) => ({ default: Stage })));
const LazySettingsModal = lazy(() => import("./components/SettingsModal").then(({ SettingsModal }) => ({ default: SettingsModal })));

/** One frozen empty list for both contribution kinds the compact layout leaves out. */
const EMPTY_CONTRIBUTIONS: never[] = [];

const loadFileUnavailable = async (path: string): Promise<UiFileContent> => ({ path, name: path.split("/").at(-1) ?? path, size: 0, kind: "text", text: "File contents require a document source." });
const loadDiffUnavailable = async (path: string): Promise<UiFileDiff> => ({ path, added: 0, removed: 0, hunks: [], note: "Diffs require a document source." });

export const MountedPanel = memo(function MountedPanel({
  Component,
  active,
  label,
  extensionId,
  extensionName,
  registry,
  actions,
  onNotify,
}: {
  Component: ComponentType<PanelProps>;
  active: boolean;
  label: string;
  extensionId?: string;
  extensionName: string;
  registry?: ExtensionRegistry;
  actions: WorkbenchActions;
  onNotify?(message: string): void;
}) {
  return <div className={active ? "panel active" : "panel"}>
    <LazyFeatureBoundary
      label={label.toLowerCase()}
      extensionId={extensionId}
      extensionName={extensionName}
      registry={registry}
      onNotify={onNotify}
    >
      <Suspense fallback={<LazyFeatureFallback label={label.toLowerCase()} />}>
        <Component active={active} extensionName={extensionName} actions={actions} />
      </Suspense>
    </LazyFeatureBoundary>
  </div>;
});

type DropController = ReturnType<typeof useThreadDropController>;
type Settings = PreferencesState;

/** Window chrome, slots and the modals that belong to the shell. */
export interface WorkbenchLayout {
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
  dockOpen: boolean;
  setDockOpen(open: boolean): void;
  centerRef: RefObject<HTMLDivElement | null>;
  centerCompact: boolean;
  setCenterCompact(compact: boolean): void;
  chatFocused: boolean;
  setChatFocused(focused: boolean): void;
  stage: StageState;
  activateStageTab(id: string): void;
  closeStageTab(id: string): void;
  pinStageTab(id: string): void;
  setStageFileView(id: string, view: "source" | "diff"): void;
  loadThread(sessionId: string): Promise<UiMessage[]>;
  takeOverThread(sessionId: string): void;
  documentState: { changes: UiWorkspaceChanges; editor?: UiEditor };
  documentSource: ReturnType<ExtensionRegistry["getDocumentSource"]>;
  visibleStreaming: boolean;
  paletteOpen: boolean;
  closePalette(): void;
  commands: ReturnType<ExtensionRegistry["getCommands"]>;
  projectSourcesOpen: boolean;
  closeProjectSources(): void;
  newThreadOpen: boolean;
  openNewThreadPicker(): void;
  closeNewThreadPicker(): void;
  projects: readonly UiProject[];
  removeProject(project: UiProject): void;
  createThreadInProject(project: UiProject): void;
  settingsPage?: string;
  setSettingsPage(page?: string): void;
  notice?: string;
  noticeLevel: "info" | "warning" | "error";
  setNotice(message?: string, level?: "info" | "warning" | "error"): void;
  activeOverlayId?: string;
  closeOverlay(): void;
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
  transcriptActivities: readonly TranscriptActivity[];
  liveStatusLabel?: string;
  conversationActivityTools: readonly UiToolRun[];
  runStartedAt?: number;
  activeDraftKey?: string;
  copyMessage(message: UiMessage): Promise<void>;
  forkMessage(message: UiMessage): Promise<void>;
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
  scopeStore: ComposerScopeStore;
  seed?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachmentRef: RefObject<ComposerAttachmentHandle | null>;
  queue: readonly QueuedFollowUp[];
  holds: number;
  prompts: ExtensionUiPrompt[];
  submit: (value: string, attachments?: import("../shared/contracts").UiPromptAttachment[], delivery?: "followUp" | "steer", skillDraft?: import("../shared/contracts").UiSkillDraft) => Promise<SubmitResult>;
  abort(sessionId?: string): void;
  cancelQueued(id: string): void;
  steerQueued(id: string): void;
  reorderQueue(id: string, toIndex: number): void;
  setModel(provider: string, id: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  answerUiPrompt(id: string, answer: import("../shared/contracts").ExtensionUiAnswer): void;
  compactContext(): Promise<void>;
}

export interface WorkbenchModel {
  /** The one store the transcript and the context meter subscribe to themselves. */
  view: ThreadViewStore;
  actions: WorkbenchActions;
  context: WorkbenchContextValue;
  shellContext: WorkbenchShellContextValue;
  observatoryContext: ObservatoryContextValue;
  layout: WorkbenchLayout;
  thread: WorkbenchThread;
  composer: WorkbenchComposer;
}

export const Workbench = memo(function Workbench({ model }: { model: WorkbenchModel }) {
  const { actions, layout, thread, composer, view } = model;
  const {
    registry, threadStore, settings, layoutProfile, workspaceCwd, sidebarContributions: allSidebarContributions, panels: allPanels, activePanel,
    openedPanels, openPanel, dockOpen, setDockOpen, centerRef, centerCompact, setCenterCompact,
    chatFocused, setChatFocused, stage, activateStageTab, closeStageTab, pinStageTab, setStageFileView,
    loadThread, takeOverThread,
    documentState, documentSource, visibleStreaming, paletteOpen, closePalette, commands,
    projectSourcesOpen, closeProjectSources, newThreadOpen, openNewThreadPicker, closeNewThreadPicker,
    projects, removeProject, createThreadInProject, settingsPage, setSettingsPage, notice, noticeLevel,
    setNotice, activeOverlayId, closeOverlay,
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
  const [dockWidth, setDockWidthState] = useState(() => storedDockWidth(clientStorage));
  const dockResizeCleanupRef = useRef<(() => void) | undefined>(undefined);
  // One screen wide: the thread list is a sheet and the dock has nowhere to go.
  // The registry still holds those contributions; only this layout leaves them out.
  const compact = layoutProfile === "compact";
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const sidebarContributions = compact ? EMPTY_CONTRIBUTIONS : allSidebarContributions;
  const panels = compact ? EMPTY_CONTRIBUTIONS : allPanels;
  useEffect(() => { if (!compact) setThreadSheetOpen(false); }, [compact]);
  // The sheet is `aria-modal`, so core's own Escape binding stands down for it;
  // closing it is this listener's job.
  useEffect(() => {
    if (!threadSheetOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setThreadSheetOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [threadSheetOpen]);

  const setDockWidth = (width: number) => {
    const bounded = clampDockWidth(width);
    setDockWidthState(bounded);
    clientStorage.set(DOCK_WIDTH_KEY, String(bounded));
  };

  const startDockResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dockResizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = dockWidth;
    const onMove = (moveEvent: PointerEvent) => setDockWidth(startWidth - (moveEvent.clientX - startX));
    const onUp = () => dockResizeCleanupRef.current?.();
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("dock-resizing");
      dockResizeCleanupRef.current = undefined;
    };
    dockResizeCleanupRef.current = cleanup;
    document.body.classList.add("dock-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  useEffect(() => () => dockResizeCleanupRef.current?.(), []);

  useEffect(() => {
    const element = centerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCenterCompact(entry.contentRect.width < CENTER_SPLIT_MIN_WIDTH));
    observer.observe(element);
    return () => observer.disconnect();
  }, [centerRef, setCenterCompact]);

  // Toasts float over this column instead of the window, so they never land on
  // the dock — where the host may be drawing a native view no z-index outranks.
  useEffect(() => {
    const element = centerRef.current;
    return element ? publishStageBand(element) : undefined;
  }, [centerRef]);

  const centerClassName = [
    "workbench-center",
    stage.tabs.length > 0 ? "stage-open" : "",
    centerCompact ? "compact" : "",
    centerCompact && chatFocused ? "chat-focused" : "",
  ].filter(Boolean).join(" ");
  const shellClassName = [
    "app-shell",
    sidebarContributions.length === 0 ? "no-sidebar" : "",
    panels.length === 0 ? "no-dock" : "",
    dockOpen ? "" : "dock-closed",
  ].filter(Boolean).join(" ");

  const openSupervisedThread = (row: { path: string }) => {
    setThreadSheetOpen(false);
    void actions.switchSession(row.path);
  };
  const threadSupervisor = <ThreadSupervisor
    onOpen={openSupervisedThread}
    onStop={(row) => composer.abort(row.id)}
  />;

  const conversationComposer = <ConversationComposer
    view={view}
    composer={composer}
    snapshot={snapshot}
    conversationSnapshot={conversationSnapshot}
    pendingNewThread={pendingNewThread}
    showStartScreen={showStartScreen}
    activeDraftKey={activeDraftKey}
    onNotify={actions.notify}
  />;

  const overlays = <>
    {compact && threadSheetOpen ? <div className="thread-sheet-scrim" onClick={() => setThreadSheetOpen(false)}>
      <section
        className="thread-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Threads"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>Threads</strong>
          <button type="button" aria-label="Close threads" onClick={() => setThreadSheetOpen(false)}><X size={14} /></button>
        </header>
        {threadSupervisor}
        <button type="button" className="thread-sheet-new" onClick={() => { setThreadSheetOpen(false); openNewThreadPicker(); }}>New thread</button>
      </section>
    </div> : null}
    {threadTreeModal ? <ThreadTreeModal
      tree={threadTreeModal.tree} mode={threadTreeModal.mode} busy={threadTreeModal.busy} error={threadTreeModal.error}
      onClose={closeThreadTree} onNavigate={(entryId, summarize) => void navigateThreadTree(entryId, summarize)} onFork={(entryId) => void forkFromTree(entryId)}
    /> : null}
    {systemPromptOpen ? <SystemPromptModal threadId={snapshot?.sessionId} onClose={() => setSystemPromptOpen(false)} /> : null}
    <LazyFeatureBoundary label="command palette">
      <Suspense fallback={<LazyFeatureFallback label="command palette" />}>
        <LazyCommandPalette
          open={paletteOpen}
          shortcutFor={(commandId) => registry.keybindingLabel(commandId)}
          commands={commands}
          extensionCount={registry.getExtensionNames().length}
          actions={actions}
          onClose={closePalette}
        />
      </Suspense>
    </LazyFeatureBoundary>
    {projectSourcesOpen ? <ProjectSourcesModal actions={actions} onClose={closeProjectSources} sources={registry.getProjectSources()} /> : null}
    <ProjectPicker
      open={newThreadOpen}
      projects={projects}
      onBrowse={() => actions.openProjectSources()}
      onClose={closeNewThreadPicker}
      onRemove={removeProject}
      onSelect={createThreadInProject}
    />
    {settingsPage ? <LazyFeatureBoundary label="settings">
      <Suspense fallback={<LazyFeatureFallback label="settings" />}>
        <LazySettingsModal
          page={settingsPage}
          snapshot={snapshot}
          registry={registry}
          onSetPage={setSettingsPage}
          onSetModel={(provider, id) => void setModel(provider, id)}
          onSetThinking={(level) => void setThinking(level)}
          onClose={() => setSettingsPage(undefined)}
          onNotify={setNotice}
        />
      </Suspense>
    </LazyFeatureBoundary> : null}
    {notice ? <button className="toast" data-level={noticeLevel} onClick={() => setNotice(undefined)}>
      <b>{noticeLevel === "info" ? "NOTICE" : noticeLevel.toUpperCase()}</b><span>{notice}</span><i>×</i>
    </button> : null}
  </>;

  const activeOverlay = registry.getOverlay(activeOverlayId);
  const providers = (content: React.ReactNode) => <ThreadStoreContext.Provider value={threadStore}>
    <WorkbenchShellContext.Provider value={model.shellContext}>
      <WorkbenchContext.Provider value={model.context}>
        <ObservatoryContext.Provider value={model.observatoryContext}>{content}</ObservatoryContext.Provider>
      </WorkbenchContext.Provider>
    </WorkbenchShellContext.Provider>
  </ThreadStoreContext.Provider>;
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
  </>);

  return providers(<>
    <div className={shellClassName} style={{ "--dock-width": panels.length === 0 || !dockOpen ? "0px" : `${dockWidth}px` } as CSSProperties}>
      <TitleBar
        cwd={workspaceCwd}
        dockOpen={dockOpen}
        hasDock={panels.length > 0}
        registry={registry}
        snapshot={snapshot}
        actions={actions}
        onToggleDock={() => setDockOpen(!dockOpen)}
        {...(compact ? { onOpenThreads: () => setThreadSheetOpen(true) } : {})}
      />
      {sidebarContributions.map((contribution) => <LazyFeatureBoundary
        key={contribution.id}
        label="sidebar"
        extensionId={contribution.extensionId}
        extensionName={contribution.extensionName}
        registry={registry}
        onNotify={actions.notify}
      >
        <Suspense fallback={<LazyFeatureFallback label="sidebar" />}><contribution.Component actions={actions} /></Suspense>
      </LazyFeatureBoundary>)}
      <div className={centerClassName} ref={centerRef}>
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
                  <span><small>Current project</small><strong>{startProjectName}</strong><code title={startProjectPath}>{displayPath(startProjectPath)}</code></span>
                  <b>Change</b><ChevronDown size={15} />
                </button>
              </> : null}
              <Region registry={registry} placement="composer-above" snapshot={snapshot} actions={actions} />
              <ComposerHost start={showStartScreen}>{conversationComposer}</ComposerHost>
              <Region registry={registry} placement="composer-below" snapshot={snapshot} actions={actions} />
              {compact && showStartScreen ? <section className="supervision-start" aria-label="Agent supervision">
                <h2>Threads</h2>
                {threadSupervisor}
              </section> : null}
            </div>
          </section>
          <div className="conversation-thread">
            {!showStartScreen ? <>
              <Region registry={registry} placement="transcript-header" snapshot={snapshot} actions={actions} />
              <header className="conversation-header">
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
                <span className="title-spacer" />
              </header>
              <ConversationTranscript view={view} thread={thread} />
              <Region registry={registry} placement="transcript-footer" snapshot={snapshot} actions={actions} />
            </> : null}
          </div>
          <HostConnectionStatus />
          <StatusLine registry={registry} snapshot={snapshot} actions={actions} />
        </main>
        {stage.tabs.length > 0 ? <LazyFeatureBoundary label="stage">
          <Suspense fallback={<section className="stage"><LazyFeatureFallback label="stage" /></section>}>
            <LazyStage
              stage={stage}
              cwd={snapshot?.cwd}
              changes={documentState.changes}
              editor={documentState.editor}
              chatTab={centerCompact ? { active: chatFocused, streaming: visibleStreaming, onSelect: setChatFocused } : undefined}
              loadFile={documentSource?.loadFile ?? loadFileUnavailable}
              loadDiff={documentSource?.loadDiff ?? loadDiffUnavailable}
              loadThread={loadThread}
              onActivate={activateStageTab}
              onClose={closeStageTab}
              onPin={pinStageTab}
              onChangeView={setStageFileView}
              onOpenInEditor={(path) => platform.files?.openInEditor(path)}
              onTakeOverThread={takeOverThread}
            />
          </Suspense>
        </LazyFeatureBoundary> : null}
      </div>
      {panels.length > 0 ? <aside className="instrument-dock">
        {dockOpen ? <div
          className="dock-resizer"
          role="separator"
          aria-label="Resize right sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_DOCK_WIDTH}
          aria-valuemax={MAX_DOCK_WIDTH}
          aria-valuenow={dockWidth}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          onPointerDown={startDockResize}
          onDoubleClick={() => setDockWidth(DEFAULT_DOCK_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
            event.preventDefault();
            setDockWidth(event.key === "Home" ? DEFAULT_DOCK_WIDTH : dockWidth + (event.key === "ArrowLeft" ? 16 : -16));
          }}
        /> : null}
        {dockOpen ? <div className="panel-stage">{panels.map((panel) => openedPanels.has(panel.id) ? <MountedPanel
          key={panel.id}
          Component={panel.Component}
          active={activePanel === panel.id}
          label={panel.label}
          extensionId={panel.extensionId}
          extensionName={panel.extensionName}
          registry={registry}
          actions={actions}
          onNotify={actions.notify}
        /> : null)}</div> : null}
        <nav className="panel-rail">
          {panels.map((panel) => <button
            key={panel.id}
            title={panel.label}
            aria-label={panel.label}
            className={dockOpen && activePanel === panel.id ? "active" : ""}
            aria-pressed={dockOpen && activePanel === panel.id}
            onClick={() => dockOpen && activePanel === panel.id ? setDockOpen(false) : openPanel(panel.id)}
          ><PanelIcon Icon={panel.Icon} /></button>)}
          <span className="spacer" />
        </nav>
      </aside> : null}
    </div>
    {overlays}
  </>);
});

/**
 * The transcript follows the store on its own. A streamed delta re-renders
 * this subtree and leaves the rest of the workbench untouched.
 */
function ConversationTranscript({ view, thread }: { view: ThreadViewStore; thread: WorkbenchThread }) {
  const transcript = useSyncExternalStore(view.subscribeToTranscript, view.getTranscript);
  const optimistic = useSyncExternalStore(view.subscribeToOptimistic, view.getOptimisticMessages);
  const preferences = usePreferences();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const {
    conversationSnapshot, pendingNewThread, transcriptHistory, transcriptRef, loadTranscriptPage,
    applyTranscriptPage, transcriptScopeKey, transcriptScope, transcriptTurnStart,
    visibleTranscriptTurnStart, transcriptActivities, liveStatusLabel, conversationActivityTools,
    runStartedAt, activeDraftKey, copyMessage, forkMessage,
  } = thread;
  const messages = useMemo(
    () => conversationMessagesFor(transcript.messages, optimistic, activeDraftKey, pendingNewThread),
    [activeDraftKey, optimistic, pendingNewThread, transcript],
  );
  return <TranscriptHistoryBoundary
    controller={transcriptHistory}
    scrollRef={transcriptRef}
    showControl={!pendingNewThread && messages.length > 0}
    loadPage={loadTranscriptPage}
    applyPage={applyTranscriptPage}
  >
    {() => <TranscriptViewport
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
      detail={preferences.transcriptDetailFor(conversationSnapshot?.sessionId)}
      liveStatus={liveStatusLabel !== undefined
        ? <LiveStatus label={liveStatusLabel} />
        : conversationSnapshot?.isStreaming && conversationActivityTools.length === 0
          ? <LiveStatus startedAt={runStartedAt} />
          : undefined}
      onCopyMessage={(message) => void copyMessage(message)}
      onForkMessage={(message) => void forkMessage(message)}
    />}
  </TranscriptHistoryBoundary>;
}

/** The context meter reads the running token estimate, so the composer subscribes too. */
function ConversationComposer({ view, composer, snapshot, conversationSnapshot, pendingNewThread, showStartScreen, activeDraftKey, onNotify }: {
  view: ThreadViewStore;
  composer: WorkbenchComposer;
  snapshot?: HostSnapshot;
  conversationSnapshot?: HostSnapshot;
  pendingNewThread: boolean;
  showStartScreen: boolean;
  activeDraftKey?: string;
  onNotify?(message: string): void;
}) {
  const transcript = useSyncExternalStore(view.subscribeToTranscript, view.getTranscript);
  const tools = useSyncExternalStore(view.subscribeToTools, view.getToolView).tools;
  const preferences = usePreferences();
  const { showCosts, newThreadRuntime } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  // The runtime is a property of the thread; it is chosen before the thread exists and never after.
  const runtimeBackends = snapshot?.runtimeBackends ?? [];
  const runtimeChoice = pendingNewThread && runtimeBackends.length > 1
    ? { kind: effectiveNewThreadRuntime(newThreadRuntime, snapshot), backends: runtimeBackends, onSelect: (kind: string) => preferences.setNewThreadRuntime(kind) }
    : undefined;
  const {
    scopeStore, seed, textareaRef, attachmentRef, queue, holds, prompts, submit, abort,
    cancelQueued, steerQueued, reorderQueue, setModel, setThinking, answerUiPrompt, compactContext,
  } = composer;
  const contextBreakdown = useMemo(
    () => contextBreakdownFor(snapshot?.contextUsage, transcript.tokenEstimate, tools),
    [snapshot?.contextUsage, tools, transcript.tokenEstimate],
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
    onSubmit={(text, attachments, delivery, skillDraft) => submit(text ?? "", attachments, delivery, skillDraft)}
    onAbort={() => abort(snapshot?.sessionId)}
    onCancelQueued={cancelQueued}
    onSteerQueued={steerQueued}
    onReorderQueue={reorderQueue}
    onSetModel={(provider, id) => void setModel(provider, id)}
    onSetThinking={(level) => void setThinking(level)}
    runtimeChoice={runtimeChoice}
    prompt={prompts[0]}
    promptsPending={Math.max(0, prompts.length - 1)}
    onAnswerPrompt={(value, typed) => {
      const active = prompts[0];
      if (active) answerUiPrompt(active.id, typeof value === "boolean" ? { confirmed: value } : typed ? { value, typed } : { value });
    }}
    onCancelPrompt={() => {
      const active = prompts[0];
      if (active) answerUiPrompt(active.id, { cancelled: true });
    }}
    onCompactContext={() => void compactContext()}
    held={holds > 0}
    onNotify={onNotify}
  />;
}
