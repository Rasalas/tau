import { lazy, memo, Suspense, useEffect, useRef, useState, type ComponentType, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ChevronDown, Folder, PanelRight, PanelRightClose } from "lucide-react";
import type { ExtensionUiPrompt, HostSnapshot, UiMessage, UiProject, UiToolRun, UiThreadTree } from "../shared/contracts";
import type { UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { activateTab as activateStageTab, closeTab as closeStageTab, pinTab as pinStageTab, setFileView, type StageState } from "./stage";
import type { ComposerAttachmentHandle, SubmitResult } from "./components/Composer";
import { Composer } from "./components/Composer";
import type { ComposerScopeStore } from "./composer-scope-store";
import type { QueuedFollowUp } from "./follow-up-queue";
import type { ContextBreakdown } from "./components/ContextMeter";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { ComposerHost, LiveStatus } from "./components/ComposerHost";
import { PanelIcon } from "./components/PanelIcon";
import { ProjectPicker } from "./components/ProjectPicker";
import { ProjectSourcesModal } from "./components/ProjectSources";
import { Region, StatusLine } from "./components/Regions";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
import { ThreadTreeModal, type ThreadTreeMode } from "./components/ThreadTreeModal";
import { TitleBar } from "./components/TitleBar";
import { TranscriptHistoryBoundary } from "./components/TranscriptHistoryBoundary";
import { TranscriptViewport } from "./components/TranscriptViewport";
import type { TranscriptActivity } from "./components/transcript-activity";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import { preferences } from "./preferences";
import type { ThreadStore } from "./thread-store";
import type { TranscriptHistoryController } from "./transcript-history";
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
const DOCK_WIDTH_KEY = "tau:dock-width";

function clampDockWidth(width: number): number {
  return Number.isFinite(width)
    ? Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, width))
    : DEFAULT_DOCK_WIDTH;
}

function storedDockWidth(): number {
  const width = Number(window.localStorage.getItem(DOCK_WIDTH_KEY));
  return Number.isFinite(width) && width > 0 ? clampDockWidth(width) : DEFAULT_DOCK_WIDTH;
}
const LazyCommandPalette = lazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const LazyStage = lazy(() => import("./components/Stage").then(({ Stage }) => ({ default: Stage })));
const LazySettingsModal = lazy(() => import("./components/SettingsModal").then(({ SettingsModal }) => ({ default: SettingsModal })));

const loadFileUnavailable = async (path: string): Promise<UiFileContent> => ({ path, name: path.split("/").at(-1) ?? path, size: 0, kind: "text", text: "File contents require a document source." });
const loadDiffUnavailable = async (path: string): Promise<UiFileDiff> => ({ path, added: 0, removed: 0, hunks: [], note: "Diffs require a document source." });

export const MountedPanel = memo(function MountedPanel({
  Component,
  active,
  label,
  extensionName,
}: {
  Component: ComponentType<{ active: boolean; extensionName: string }>;
  active: boolean;
  label: string;
  extensionName: string;
}) {
  return <div className={active ? "panel active" : "panel"}>
    <LazyFeatureBoundary label={label.toLowerCase()}>
      <Suspense fallback={<LazyFeatureFallback label={label.toLowerCase()} />}>
        <Component active={active} extensionName={extensionName} />
      </Suspense>
    </LazyFeatureBoundary>
  </div>;
});

type DropController = ReturnType<typeof useThreadDropController>;
type Settings = ReturnType<typeof preferences.getSnapshot>;

export interface WorkbenchModel {
  registry: ExtensionRegistry;
  actions: WorkbenchActions;
  threadStore: ThreadStore;
  context: WorkbenchContextValue;
  shellContext: WorkbenchShellContextValue;
  observatoryContext: ObservatoryContextValue;
  snapshot?: HostSnapshot;
  workspaceCwd?: string;
  dockOpen: boolean;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  sidebarContributions: ReturnType<ExtensionRegistry["getSidebarContributions"]>;
  panels: ReturnType<ExtensionRegistry["getPanels"]>;
  activePanel: string;
  openedPanels: ReadonlySet<string>;
  openPanel(id: string): void;
  centerRef: RefObject<HTMLDivElement | null>;
  centerCompact: boolean;
  setCenterCompact: Dispatch<SetStateAction<boolean>>;
  chatFocused: boolean;
  setChatFocused: Dispatch<SetStateAction<boolean>>;
  stage: StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  documentState: { changes: UiWorkspaceChanges; editor?: UiEditor };
  documentSource: ReturnType<ExtensionRegistry["getDocumentSource"]>;
  visibleStreaming: boolean;
  showStartScreen: boolean;
  startProjectPath: string;
  startProjectName: string;
  setNewThreadOpen: Dispatch<SetStateAction<boolean>>;
  dropController: DropController;
  conversationSnapshot?: HostSnapshot;
  composerScopeStore: ComposerScopeStore;
  composerSeed?: string;
  activeDraftKey?: string;
  queue: readonly QueuedFollowUp[];
  contextBreakdown: ContextBreakdown;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  composerAttachmentRef: RefObject<ComposerAttachmentHandle | null>;
  submit: (value: string, attachments?: import("../shared/contracts").UiPromptAttachment[], delivery?: "followUp" | "steer", skillDraft?: import("../shared/contracts").UiSkillDraft) => Promise<SubmitResult>;
  cancelQueued(id: string): void;
  steerQueued(id: string): void;
  reorderQueue(id: string, toIndex: number): void;
  setModel(provider: string, id: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  conversationPrompts: ExtensionUiPrompt[];
  answerUiPrompt(id: string, answer: import("../shared/contracts").ExtensionUiAnswer): void;
  compactContext(): Promise<void>;
  composerHolds: number;
  settings: Settings;
  titleCommands: ReturnType<ExtensionRegistry["getCommandsFor"]>;
  openThreadTree(mode?: ThreadTreeMode): void;
  duplicateThread(): Promise<boolean>;
  settleActiveThread(): void;
  renameThread(title: string): Promise<boolean>;
  copyThreadValue(kind: "chat" | "path" | "thread-id"): Promise<void>;
  pendingNewThread: boolean;
  conversationMessages: UiMessage[];
  transcriptHistory: TranscriptHistoryController;
  transcriptRef: RefObject<HTMLDivElement | null>;
  loadTranscriptPage(sessionId: string, cursor: HostTranscriptCursor): Promise<import("../shared/host-protocol").TranscriptPage>;
  applyTranscriptPage(page: import("../shared/host-protocol").TranscriptPage, request: import("./transcript-history").TranscriptHistoryRequest): boolean;
  transcriptScopeKey: string;
  transcriptRevision: number;
  transcriptLookupRevision: number;
  transcriptScope: import("./components/transcript-navigation").TranscriptNavigationScope;
  transcriptTurnStart?: TranscriptTurnStart;
  visibleTranscriptTurnStart?: TranscriptTurnStart;
  transcriptActivities: readonly TranscriptActivity[];
  liveStatusLabel?: string;
  conversationActivityTools: UiToolRun[];
  runStartedAt?: number;
  copyMessage(message: UiMessage): Promise<void>;
  forkMessage(message: UiMessage): Promise<void>;
  threadTreeModal?: { tree?: UiThreadTree; mode: ThreadTreeMode; busy: boolean; error?: string };
  setThreadTreeModal: Dispatch<SetStateAction<{ tree?: UiThreadTree; mode: ThreadTreeMode; busy: boolean; error?: string } | undefined>>;
  navigateThreadTree(entryId: string, summarize: boolean): Promise<void>;
  forkFromTree(entryId: string): Promise<void>;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  commands: ReturnType<ExtensionRegistry["getCommands"]>;
  projectSourcesOpen: boolean;
  setProjectSourcesOpen: Dispatch<SetStateAction<boolean>>;
  newThreadOpen: boolean;
  projects: readonly UiProject[];
  removeProject(project: UiProject): void;
  createThreadInProject(project: UiProject): void;
  settingsPage?: string;
  setSettingsPage: Dispatch<SetStateAction<string | undefined>>;
  notice?: string;
  noticeLevel: "info" | "warning" | "error";
  setNotice(message?: string, level?: "info" | "warning" | "error"): void;
  activeOverlayId?: string;
  setActiveOverlayId: Dispatch<SetStateAction<string | undefined>>;
}

export function Workbench({ model }: { model: WorkbenchModel }) {
  const {
    registry, actions, threadStore, snapshot, workspaceCwd, dockOpen, setDockOpen, sidebarContributions,
    panels, activePanel, openedPanels, openPanel, centerRef, centerCompact, setCenterCompact, chatFocused,
    setChatFocused, stage, setStage, documentState, documentSource, visibleStreaming, showStartScreen,
    startProjectPath, startProjectName, setNewThreadOpen, dropController, conversationSnapshot,
    composerScopeStore, composerSeed, activeDraftKey, queue, contextBreakdown, composerRef,
    composerAttachmentRef, submit, cancelQueued, steerQueued, reorderQueue, setModel, setThinking, conversationPrompts, answerUiPrompt,
    compactContext, composerHolds, settings, titleCommands, openThreadTree, duplicateThread,
    settleActiveThread, renameThread, copyThreadValue, pendingNewThread, conversationMessages,
    transcriptHistory, transcriptRef, loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptRevision, transcriptLookupRevision, transcriptScope, transcriptTurnStart,
    visibleTranscriptTurnStart, transcriptActivities, liveStatusLabel, conversationActivityTools,
    runStartedAt, copyMessage, forkMessage, threadTreeModal, setThreadTreeModal, navigateThreadTree,
    forkFromTree, paletteOpen, setPaletteOpen, commands, projectSourcesOpen, setProjectSourcesOpen,
    newThreadOpen, projects, removeProject, createThreadInProject, settingsPage, setSettingsPage,
    notice, noticeLevel, setNotice, activeOverlayId, setActiveOverlayId,
  } = model;
  const [dockWidth, setDockWidthState] = useState(storedDockWidth);
  const dockResizeCleanupRef = useRef<(() => void) | undefined>(undefined);

  const setDockWidth = (width: number) => {
    const bounded = clampDockWidth(width);
    setDockWidthState(bounded);
    window.localStorage.setItem(DOCK_WIDTH_KEY, String(bounded));
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

  const conversationComposer = <Composer
    snapshot={conversationSnapshot}
    scopeStore={composerScopeStore}
    seed={composerSeed}
    draftStorageKey={activeDraftKey}
    queue={queue}
    contextUsage={snapshot?.contextUsage}
    contextBreakdown={contextBreakdown}
    textareaRef={composerRef}
    attachmentRef={composerAttachmentRef}
    onSubmit={(text, attachments, delivery, skillDraft) => submit(text ?? "", attachments, delivery, skillDraft)}
    onAbort={() => void window.tau?.abort(snapshot?.sessionId)}
    onCancelQueued={cancelQueued}
    onSteerQueued={steerQueued}
    onReorderQueue={reorderQueue}
    onSetModel={(provider, id) => void setModel(provider, id)}
    onSetThinking={(level) => void setThinking(level)}
    prompt={conversationPrompts[0]}
    promptsPending={Math.max(0, conversationPrompts.length - 1)}
    onAnswerPrompt={(value, typed) => {
      const active = conversationPrompts[0];
      if (active) answerUiPrompt(active.id, typeof value === "boolean" ? { confirmed: value } : typed ? { value, typed } : { value });
    }}
    onCancelPrompt={() => {
      const active = conversationPrompts[0];
      if (active) answerUiPrompt(active.id, { cancelled: true });
    }}
    onCompactContext={() => void compactContext()}
    held={composerHolds > 0}
  />;

  const overlays = <>
    {threadTreeModal ? <ThreadTreeModal
      tree={threadTreeModal.tree}
      mode={threadTreeModal.mode}
      busy={threadTreeModal.busy}
      error={threadTreeModal.error}
      onClose={() => setThreadTreeModal(undefined)}
      onNavigate={(entryId, summarize) => void navigateThreadTree(entryId, summarize)}
      onFork={(entryId) => void forkFromTree(entryId)}
    /> : null}
    <LazyFeatureBoundary label="command palette">
      <Suspense fallback={<LazyFeatureFallback label="command palette" />}>
        <LazyCommandPalette
          open={paletteOpen}
          shortcutFor={(commandId) => registry.keybindingLabel(commandId)}
          commands={commands}
          extensionCount={registry.getExtensionNames().length}
          actions={actions}
          onClose={() => setPaletteOpen(false)}
        />
      </Suspense>
    </LazyFeatureBoundary>
    {projectSourcesOpen ? <ProjectSourcesModal actions={actions} onClose={() => setProjectSourcesOpen(false)} sources={registry.getProjectSources()} /> : null}
    <ProjectPicker
      open={newThreadOpen}
      projects={projects}
      onBrowse={() => actions.openProjectSources()}
      onClose={() => setNewThreadOpen(false)}
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
    <LazyFeatureBoundary label={activeOverlay.id}>
      <Suspense fallback={<LazyFeatureFallback label={activeOverlay.id} />}>
        <activeOverlay.Component actions={actions} onClose={() => setActiveOverlayId(undefined)} />
      </Suspense>
    </LazyFeatureBoundary>
    {overlays}
  </>);

  return providers(<>
    <div className={shellClassName} style={{ "--dock-width": `${dockWidth}px` } as CSSProperties}>
      <TitleBar cwd={workspaceCwd} dockOpen={dockOpen} registry={registry} snapshot={snapshot} actions={actions} onToggleDock={() => setDockOpen((value) => !value)} />
      {sidebarContributions.map((contribution) => <LazyFeatureBoundary key={contribution.id} label="sidebar">
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
                <button type="button" className="conversation-start-project" aria-label={`Change project, current project ${startProjectName}`} onClick={() => setNewThreadOpen(true)}>
                  <i><Folder size={17} /></i>
                  <span><small>Current project</small><strong>{startProjectName}</strong><code title={startProjectPath}>{displayPath(startProjectPath)}</code></span>
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
              <header className="conversation-header">
                <ThreadTitleMenu
                  title={conversationSnapshot?.sessionTitle || "Untitled thread"}
                  label={snapshot?.projectLabel}
                  pinned={Boolean(snapshot?.sessionId && settings.pinnedThreadIds.includes(snapshot.sessionId))}
                  settled={Boolean(snapshot?.sessionId && settings.settledThreadIds.includes(snapshot.sessionId))}
                  onNewThread={() => setNewThreadOpen(true)}
                  onOpenTree={() => openThreadTree("navigate")}
                  onDuplicate={() => void duplicateThread()}
                  onTogglePin={() => { if (snapshot?.sessionId) preferences.togglePinned(snapshot.sessionId); }}
                  onToggleSettled={settleActiveThread}
                  onRename={renameThread}
                  commands={titleCommands}
                  onCommand={(id) => { void titleCommands.find((command) => command.id === id)?.run(actions); }}
                  onMarkUnread={() => { if (snapshot?.sessionId) threadStore.markUnread(snapshot.sessionId); }}
                  onCopy={(kind) => void copyThreadValue(kind)}
                />
                <span className="title-spacer" />
              </header>
              <TranscriptHistoryBoundary
                controller={transcriptHistory}
                scrollRef={transcriptRef}
                showControl={!pendingNewThread && conversationMessages.length > 0}
                loadPage={loadTranscriptPage}
                applyPage={applyTranscriptPage}
              >
                {() => <TranscriptViewport
                  messages={conversationMessages}
                  scrollRef={transcriptRef}
                  sessionId={conversationSnapshot?.sessionId}
                  scopeKey={transcriptScopeKey}
                  revision={transcriptRevision}
                  lookupRevision={transcriptLookupRevision}
                  scope={transcriptTurnStart?.scope ?? transcriptScope}
                  turnStart={visibleTranscriptTurnStart}
                  isStreaming={Boolean(conversationSnapshot?.isStreaming)}
                  activities={transcriptActivities}
                  liveStatus={liveStatusLabel !== undefined
                    ? <LiveStatus label={liveStatusLabel} />
                    : conversationSnapshot?.isStreaming && conversationActivityTools.length === 0
                      ? <LiveStatus startedAt={runStartedAt} />
                      : undefined}
                  onCopyMessage={(message) => void copyMessage(message)}
                  onForkMessage={(message) => void forkMessage(message)}
                />}
              </TranscriptHistoryBoundary>
              <Region registry={registry} placement="transcript-footer" snapshot={snapshot} actions={actions} />
            </> : null}
          </div>
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
              onActivate={(id) => setStage((current) => activateStageTab(current, id))}
              onClose={(id) => setStage((current) => closeStageTab(current, id))}
              onPin={(id) => setStage((current) => pinStageTab(current, id))}
              onChangeView={(id, view) => setStage((current) => setFileView(current, id, view))}
              onOpenInEditor={(path) => documentSource?.openInEditor(path)}
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
          extensionName={panel.extensionName}
        /> : null)}</div> : null}
        <nav className="panel-rail">
          {panels.map((panel) => <button
            key={panel.id}
            title={panel.label}
            aria-label={panel.label}
            className={dockOpen && activePanel === panel.id ? "active" : ""}
            aria-pressed={dockOpen && activePanel === panel.id}
            onClick={() => dockOpen && activePanel === panel.id ? setDockOpen(false) : openPanel(panel.id)}
          ><PanelIcon name={panel.glyph} /></button>)}
          <span className="spacer" />
          <button title={dockOpen ? "Collapse panel" : "Expand panel"} aria-label={dockOpen ? "Collapse panel" : "Expand panel"} onClick={() => setDockOpen((value) => !value)}>
            {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
          </button>
        </nav>
      </aside> : null}
    </div>
    {overlays}
  </>);
}
