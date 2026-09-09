import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HostEvent, UiMessage } from "../shared/contracts";
import type { UiEditor, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { mockSnapshot, mockThreadIndex, reconcileOptimisticMessages, transcriptNavigationScope, transcriptNavigationScopeKey } from "../workbench/app-state";
import { WorkbenchStore } from "../workbench/workbench-store";
import { ThreadCommands } from "../workbench/thread-commands";
import { useThreadNavigation } from "./use-thread-navigation";
import { useThreadTree } from "./use-thread-tree";
import { readBootstrapCache } from "../workbench/bootstrap-cache";
import { type ComposerAttachmentHandle } from "./components/Composer";
import { visibleUserMessageText } from "./components/MessageText";
import { UpdateToast } from "./components/UpdateToast";
import type { TranscriptTurnStart } from "../workbench/transcript-navigation";
import { ComposerScopeStore, createDraftKey } from "../workbench/composer-scope-store";
import { useConversationActivities } from "./conversation-activities";
import { draftKey, writeNewThreadDraft } from "../workbench/draft-store";
import { errorMessage } from "../workbench/error-message";
import { ExtensionRegistry, hostExtensionBridge, type WorkbenchActions } from "./extension-system";
import { runtimeControls } from "./settings/runtime-controls";
import { FollowUpQueueStore } from "../workbench/follow-up-queue";
import { useHostClient } from "./host-client-context";
import { useClientStorage } from "./client-storage-context";
import { applyHostEvent, type HostEventTargets } from "../workbench/host-events";
import { PlatformProvider, setPlatform } from "./platform-context";
import { useClientEnvironment } from "./client-environment";
import { useLayoutProfile } from "./use-layout-profile";
import { HOST_CAPABILITY } from "../shared/host-transport";
import { usePreferences, useRendererServices } from "./renderer-services-context";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { activateTab as activateStageTab, activeTab as activeStageTab, closeTab as closeStageTab, openFileTab, openThreadTab, pinTab as pinStageTab, setFileView, stageTabPath, type StageView } from "../workbench/stage";
import { SubmissionController, type SubmissionControllerPorts } from "./submission-controller";
import { ThreadStore } from "../workbench/thread-store";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { TranscriptHistoryController } from "../workbench/transcript-history";
import { writeCachedTurnActivity } from "../workbench/turn-activity";
import { useFollowUpQueue, type SubmitPrompt } from "./use-follow-up-queue";
import { useNewThreadController } from "./use-new-thread-controller";
import { usePreparedThreadCapability } from "./use-prepared-thread-capability";
import { useThreadDropController } from "./use-thread-drop-controller";
import { useWorkbenchReload } from "./use-workbench-reload";
import { Workbench, type WorkbenchComposer, type WorkbenchLayout, type WorkbenchModel, type WorkbenchThread } from "./Workbench";

const noopSubscribe = () => () => {};
const EMPTY_COMPOSER_ATTACHMENTS = { attachments: [] as const };
const EMPTY_DOCUMENTS: { changes: UiWorkspaceChanges; editor?: UiEditor } = { changes: { files: [], added: 0, removed: 0 } };
const emptyDocumentState = () => EMPTY_DOCUMENTS;

export default function App() {
  const client = useHostClient();
  const clientStorage = useClientStorage();
  const preferences = usePreferences();
  const constructedExtensions = useRendererServices().extensions;
  // Which client this is, whether kits were left out, and how to reach this
  // machine: the entry point decided all three before the first render.
  const { profile, safeMode, createPlatform } = useClientEnvironment();
  // What the client claims never moves; how wide it is does.
  const layoutProfile = useLayoutProfile(profile);
  const cachedBootstrap = useMemo(() => readBootstrapCache(clientStorage), [clientStorage]);
  const [registry] = useState(() => {
    const value = new ExtensionRegistry(hostExtensionBridge(client), { preferences, profile });
    // Core's own contributions come first and stay on: safe mode is a workbench
    // without kits, not one without a command palette or a model picker.
    value.activateCore(runtimeControls);
    (constructedExtensions ?? []).forEach((extension) => {
      value.addKnown(extension);
      if (!safeMode && preferences.isExtensionEnabled(extension.id)) value.activate(extension);
    });
    return value;
  });
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion);
  // What this client can do with the machine it runs on. Everything in the
  // renderer that needs the clipboard, an editor or a module evaluation asks
  // this, never Electron; `src/workbench/` never asks at all.
  const [platform] = useState(() => {
    const value = createPlatform({
      ...(client ? { client } : {}),
      storage: clientStorage,
      openInEditor: (path) => registry.getDocumentSource()?.openInEditor(path),
      hasLocalFiles: () => client?.hasCapability(HOST_CAPABILITY.localFiles) ?? false,
    });
    setPlatform(value);
    return value;
  });
  // One store owns everything about the thread on screen: its snapshot, the
  // ordered transcript, tools, prompts and the optimistic rows waiting on it.
  const [viewStore] = useState(() => new ThreadViewStore(cachedBootstrap?.snapshot));
  // Extensions from ~/.tau/extensions and <project>/.tau/extensions load at
  // runtime, like Pi's own; the project set follows the open workspace.
  const [runtimeExtensions] = useState(() => {
    installSharedModules();
    return new RuntimeExtensions(registry, {
      load: (cwd, sharedExports) => client
        ? client.loadDesktopExtensions(cwd, sharedExports)
        : Promise.resolve({ bundles: [], errors: [], skipped: [] }),
      isEnabled: (id) => preferences.isExtensionEnabled(id),
      notify: (message) => viewStore.setNotice(message),
      log: (label, detail) => viewStore.addEvent(label, detail),
    });
  });
  const [threadStore] = useState(() => {
    const store = new ThreadStore();
    if (cachedBootstrap) {
      store.applyThreadIndex(cachedBootstrap.threadIndex);
      store.applyHostSnapshot(cachedBootstrap.snapshot);
    }
    return store;
  });
  const [transcriptHistory] = useState(() => new TranscriptHistoryController(
    cachedBootstrap?.snapshot,
    cachedBootstrap?.threadIndex,
    viewStore.details,
  ));
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const threadActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);

  const snapshot = useSyncExternalStore(viewStore.subscribeToSnapshot, viewStore.getSnapshot);
  const { tools, toolAnchorId, turnActivityHistory, turnActivitySessionId } = useSyncExternalStore(
    viewStore.subscribeToTools,
    viewStore.getToolView,
  );
  const uiPrompts = useSyncExternalStore(viewStore.subscribeToPrompts, viewStore.getUiPrompts);
  const optimisticMessages = useSyncExternalStore(viewStore.subscribeToOptimistic, viewStore.getOptimisticMessages);
  const notice = useSyncExternalStore(viewStore.subscribeToNotice, viewStore.getNotice);
  const events = useSyncExternalStore(viewStore.subscribeToEvents, viewStore.getEvents);
  const setNotice = viewStore.setNotice;
  const addEvent = viewStore.addEvent;
  // Run state lives in the thread store, fed by the host's per-thread status
  // events. Every other reading of "is this thread working" is this selector,
  // so the composer, the live row and the rail cannot disagree.
  const visibleStreaming = threadActivity.isStreaming;
  const runStartedAt = threadActivity.runningStartedAt[threadActivity.activeThreadId];
  // Only the user-message slice of the transcript reaches this component: a
  // streamed delta must re-render the transcript and nothing above it.
  const transcriptUserRevision = useSyncExternalStore(viewStore.subscribeToUserMessages, viewStore.getUserRevision);
  const [activePanel, setActivePanel] = useState("");
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [projectSourcesOpen, setProjectSourcesOpen] = useState(false);
  const [activeOverlayId, setActiveOverlayId] = useState<string>();
  const newThreadController = useNewThreadController(clientStorage);
  const {
    pendingNewThread,
    setPendingNewThread,
    requestId: newThreadRequestRef,
    begin: beginNewThread,
    invalidate: invalidateNewThread,
    isCurrent: isCurrentNewThreadRequest,
    markAwaitingPromotion,
    promoteFromHostReport,
    promoteFromUserMessage,
    current: currentPendingNewThread,
  } = newThreadController;
  const [transcriptTurnStart, setTranscriptTurnStartState] = useState<TranscriptTurnStart>();
  const [settingsPage, setSettingsPage] = useState<string>();
  // Below this many pixels the centre cannot hold chat and stage side by side;
  // the chat then joins the stage's tab strip instead of losing the thread list.
  const [centerCompact, setCenterCompact] = useState(false);
  const [chatFocused, setChatFocused] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);
  const [composerHolds, setComposerHolds] = useState(0);
  const [composerSeed, setComposerSeed] = useState<string>();
  const [composerScopeStore] = useState(() => new ComposerScopeStore());
  // A delivery held for recovery changes what the workbench may do next, so
  // taking or releasing one has to reach the render.
  const [, setDeliveryVersion] = useState(0);
  const newThreadDeliveryPending = Boolean(pendingNewThread);
  const [dockOpen, setDockOpen] = useState(false);
  /** The version the host downloaded; the toast that offers the restart reads it. */
  const [updateReady, setUpdateReady] = useState<string>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachmentRef = useRef<ComposerAttachmentHandle>(null);
  const actionsRef = useRef<WorkbenchActions | undefined>(undefined);
  const clientRef = useRef(client);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptTurnStartRef = useRef<TranscriptTurnStart | undefined>(undefined);
  const activeDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
  /** The draft key as of now, for the async paths that must not read a rendered value. */
  const currentDraftKey = useCallback(
    () => draftKey(viewStore.getSnapshot()?.sessionId, currentPendingNewThread()),
    [currentPendingNewThread, viewStore],
  );
  const currentSessionId = useCallback(() => viewStore.getSnapshot()?.sessionId, [viewStore]);
  const closeNewThreadPicker = useCallback(() => setNewThreadOpen(false), []);
  // Every member is stable for the session, so the actions built on it are too.
  const newThreadPorts = useMemo(
    () => ({ current: currentPendingNewThread, set: setPendingNewThread, begin: beginNewThread, invalidate: invalidateNewThread }),
    [beginNewThread, currentPendingNewThread, invalidateNewThread, setPendingNewThread],
  );
  const transcriptScopeKey = transcriptNavigationScopeKey(snapshot, pendingNewThread);
  const transcriptScope = useMemo(
    () => transcriptNavigationScope(snapshot, pendingNewThread),
    [pendingNewThread, snapshot?.cwd, snapshot?.sessionId],
  );
  const committedTranscriptScopeKeyRef = useRef(transcriptScopeKey);
  /** The navigation scope as of now; a submission compares against it after every await. */
  const currentTranscriptScopeKey = useCallback(
    () => transcriptNavigationScopeKey(viewStore.getSnapshot(), currentPendingNewThread()),
    [currentPendingNewThread, viewStore],
  );
  const setTranscriptTurnStart = useCallback((
    next: TranscriptTurnStart | undefined,
    expectedTurnId?: string,
  ): boolean => {
    if (expectedTurnId !== undefined && transcriptTurnStartRef.current?.turnId !== expectedTurnId) return false;
    const scoped = next ? { ...next, scopeKey: next.scopeKey ?? currentTranscriptScopeKey() } : undefined;
    transcriptTurnStartRef.current = scoped;
    setTranscriptTurnStartState(scoped);
    return true;
  }, [currentTranscriptScopeKey]);
  useEffect(() => {
    const previous = committedTranscriptScopeKeyRef.current;
    if (previous === transcriptScopeKey) return;
    committedTranscriptScopeKeyRef.current = transcriptScopeKey;
    const currentTurnStart = transcriptTurnStartRef.current;
    if (currentTurnStart?.scopeKey === transcriptScopeKey && currentTurnStart.preserveAcrossSessionChange) return;
    setTranscriptTurnStart(undefined);
  }, [setTranscriptTurnStart, transcriptScopeKey]);
  const visibleTranscriptTurnStart = transcriptTurnStart?.scopeKey === transcriptScopeKey
    ? transcriptTurnStart
    : undefined;
  const [followUpQueue] = useState(() => new FollowUpQueueStore());
  // Everything between the composer and the runtime. Created once: its ports
  // are the stores, the new-thread controller and the host-update callbacks
  // declared below, all of which keep their identity for the whole session.
  const [submission] = useState<SubmissionController>(() => {
    const ports: SubmissionControllerPorts = {
      client: () => clientRef.current,
      view: viewStore,
      threads: threadStore,
      scopes: composerScopeStore,
      registry,
      storage: clientStorage,
      preferences,
      notify: (message) => viewStore.setNotice(message),
      actions: () => actionsRef.current,
      newThread: {
        current: currentPendingNewThread,
        set: (draft) => setPendingNewThread(draft),
        update: (change) => setPendingNewThread((current) => change(current)),
        requestId: () => newThreadRequestRef.current,
        isCurrent: isCurrentNewThreadRequest,
        markAwaitingPromotion,
        promoteFromUserMessage,
      },
      turn: { current: () => transcriptTurnStartRef.current, set: setTranscriptTurnStart },
      // Host updates promote a delivery and a delivery applies host updates.
      // These four must stay stable for the controller to keep reaching the
      // current ones; every dependency they have is a store or a ref.
      host: {
        applyHostUpdate: (update) => applyHostUpdate(update),
        applyActionResult: (result) => applyActionResult(result),
        applyHostResult: (result, inheritDraft) => applyHostResult(result, inheritDraft),
        prepareThreadDetail: (sessionId) => transcriptHistory.prepareActionDetail(sessionId),
      },
      enqueueFollowUp: (threadId, item) => followUpQueue.enqueue(threadId, item),
      onRecoveriesChanged: () => setDeliveryVersion((version) => version + 1),
    };
    return new SubmissionController(ports);
  });
  const submitPrompt = useCallback<SubmitPrompt>(
    (text, attachments, delivery, skillDraft) => submission.submit({ text, attachments, delivery, skillDraft }),
    [submission],
  );
  const isVisibleThreadRunning = useCallback(() => threadStore.getActivity().isStreaming, [threadStore]);
  // Follow-ups typed during a run wait in the workbench, not in the runtime.
  const { queue, cancelQueued, steerQueued, reorderQueue } = useFollowUpQueue({
    client,
    store: followUpQueue,
    sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
    isRunning: isVisibleThreadRunning,
    runningThreadIds: threadActivity.runningThreadIds,
    submit: submitPrompt,
    setNotice,
  });
  useEffect(() => {
    const reconciled = reconcileOptimisticMessages(optimisticMessages, viewStore.getTranscript().messages);
    if (reconciled.length === optimisticMessages.length) return;
    if (pendingNewThread && reconciled.every((entry) => entry.scope !== activeDraftKey)) {
      writeNewThreadDraft(clientStorage);
      setPendingNewThread(undefined);
    }
    viewStore.setOptimisticMessages(reconciled);
  }, [activeDraftKey, optimisticMessages, pendingNewThread, transcriptUserRevision]);

  const [workbenchStore] = useState(() => new WorkbenchStore({
    view: viewStore,
    threads: threadStore,
    history: transcriptHistory,
    scopes: composerScopeStore,
    storage: clientStorage,
    submission: {
      notifyHostSnapshot: () => submission.notifyHostSnapshot(),
      promoteReportedThread: (sessionId, message, requestId) => submission.promoteReportedThread(sessionId, message, requestId),
    },
    newThread: {
      current: currentPendingNewThread,
      requestId: () => newThreadRequestRef.current,
      promoteFromHostReport,
    },
    turn: { current: () => transcriptTurnStartRef.current, set: setTranscriptTurnStart },
    notify: (message) => viewStore.setNotice(message),
  }, cachedBootstrap));
  const { applySnapshot, applyThreadIndex, applyTranscriptPage, applyHostUpdate, applyActionResult } = workbenchStore;

  // Everything the workbench does to the thread on screen that is one host
  // call and a notice. It reads the client through a getter, so it survives
  // every reconnect the window does.
  const [threadCommands] = useState(() => new ThreadCommands({
    client: () => clientRef.current,
    view: viewStore,
    threads: threadStore,
    storage: clientStorage,
    platform,
    registry,
    preferences,
    applyActionResult,
  }));
  const { abort: abortThread, duplicateThread, requireHost, settleActiveThread } = threadCommands;
  const {
    stage, setStage, applyHostResult, openWorkspace, createThreadInProject, switchSession, takeOverThread,
  } = useThreadNavigation({
    ...(client ? { client } : {}),
    storage: clientStorage,
    view: viewStore,
    threads: threadStore,
    history: transcriptHistory,
    scopes: composerScopeStore,
    workbench: workbenchStore,
    requireHost,
    detachPendingDelivery: submission.detachPendingDelivery,
    newThread: newThreadPorts,
    activeDraftKey: currentDraftKey,
    composerRef,
    closeNewThreadPicker,
  });
  const { threadTreeModal, closeThreadTree, openThreadTree, navigateThreadTree, forkFromTree } = useThreadTree({
    ...(client ? { client } : {}),
    sessionId: currentSessionId,
    requireHost,
    applyActionResult,
    seedComposer: setComposerSeed,
    composerRef,
  });

  // A prepared thread is not a runtime session yet, so its project is the
  // only trustworthy workspace identity while it is on screen. In
  // particular, do not expose the last real thread's worktree in the chrome.
  const workspaceCwd = safeMode ? undefined : (pendingNewThread?.projectPath ?? snapshot?.cwd);
  const activeWorkspaceId = pendingNewThread?.workspaceId ?? snapshot?.workspaceId;
  useEffect(() => {
    if (!client) return;
    if (workspaceCwd) void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
    preferences.setWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, client, preferences, runtimeExtensions, workspaceCwd]);
  const syncDesktopExtensions = useCallback(() => {
    void runtimeExtensions.resync().catch((error) => setNotice(errorMessage(error)));
  }, [runtimeExtensions, setNotice]);

  const hostEventTargets = useMemo<HostEventTargets>(() => ({
    client,
    registry,
    threadStore,
    view: viewStore,
    submission,
    preferences,
    viewerHidden: () => document.hidden,
    currentDraftKey,
    transcriptTurnStart: () => transcriptTurnStartRef.current,
    setTranscriptTurnStart,
    applyHostUpdate,
    applyThreadIndex,
    syncDesktopExtensions,
    setUpdateReady,
  }), [applyHostUpdate, applyThreadIndex, client, currentDraftKey, preferences, registry, setTranscriptTurnStart, submission, syncDesktopExtensions, threadStore, viewStore]);
  const handleHostEvent = useCallback((event: HostEvent) => applyHostEvent(event, hostEventTargets), [hostEventTargets]);

  useEffect(() => {
    let unsubscribe = () => {};
    if (client) {
      preferences.bindHost(client, activeWorkspaceId);
      unsubscribe = client.onHostEvent(handleHostEvent);
      // A question raised while nobody was listening would otherwise stall the
      // host forever, including during bootstrap itself.
      void client.syncExtensionUi().catch(() => undefined);
      const bootstrapRequest = transcriptHistory.beginBootstrap();
      client.bootstrap().then((bootstrap) => {
        workbenchStore.applyBootstrap(bootstrap, bootstrapRequest);
      }).catch((error) => {
        if (transcriptHistory.isCurrentBootstrap(bootstrapRequest)) setNotice(errorMessage(error));
      });
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, client, handleHostEvent, transcriptHistory, workbenchStore]);

  const activeThreadIdForEvents = snapshot?.sessionId;
  useEffect(() => {
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: activeThreadIdForEvents });
  }, [activeThreadIdForEvents, registry]);

  // Opening or switching a thread should leave you ready to type — but never
  // steal the caret out of the thread search or a dialog the user is using.
  useEffect(() => {
    if (!snapshot?.sessionId) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const idle = !active || active === document.body || active.tagName === "HTML";
      if (idle) composerRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [snapshot?.sessionId]);


  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const panels = registry.getPanels();
  useEffect(() => {
    if (panels.length === 0) { setActivePanel(""); return; }
    if (!panels.some((panel) => panel.id === activePanel)) {
      setActivePanel(panels[0].id);
      setOpenedPanels((current) => current.has(panels[0].id) ? current : new Set(current).add(panels[0].id));
    }
  }, [activePanel, panels]);

  const openPanel = useCallback((id: string) => {
    setActivePanel(id);
    setOpenedPanels((current) => current.has(id) ? current : new Set(current).add(id));
    setDockOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeProjectSources = useCallback(() => setProjectSourcesOpen(false), []);
  const openNewThreadPicker = useCallback(() => setNewThreadOpen(true), []);
  const closeOverlay = useCallback(() => setActiveOverlayId(undefined), []);
  const activateStage = useCallback((id: string) => setStage((current) => activateStageTab(current, id)), []);
  const closeStage = useCallback((id: string) => setStage((current) => closeStageTab(current, id)), []);
  const pinStage = useCallback((id: string) => setStage((current) => pinStageTab(current, id)), []);
  const setStageView = useCallback((id: string, view: StageView) => setStage((current) => setFileView(current, id, view)), []);
  const openFile = useCallback((path: string, options?: { pin?: boolean; view?: StageView }) => {
    setStage((current) => openFileTab(current, path, options));
    setChatFocused(false);
  }, []);
  const openThread = useCallback((sessionId: string, options?: { pin?: boolean }) => {
    setStage((current) => openThreadTab(current, sessionId, options));
    setChatFocused(false);
  }, []);
  useEffect(() => {
    threadStore.setWaiting(uiPrompts.map((entry) => entry.sessionId));
  }, [threadStore, uiPrompts]);

  // A prompt must never be unanswerable. Workspace-level questions (project trust
  // is asked before any session exists) and questions naming a thread we do not
  // know surface on whatever thread is open; only a known other thread defers to
  // its own rail badge.
  const threadPrompts = useMemo(() => {
    const known = new Set(threadStore.getSnapshot().threads.map((thread) => thread.id));
    return uiPrompts.filter((entry) =>
      !entry.sessionId || entry.sessionId === snapshot?.sessionId || !known.has(entry.sessionId));
  }, [snapshot?.sessionId, threadStore, uiPrompts]);

  const copyMessage = useCallback((message: UiMessage) => threadCommands.copyText(
    message.role === "user" ? message.skill?.copyText ?? visibleUserMessageText(message.text) : message.text,
    "Message copied.",
  ), [threadCommands]);

  const { reloadWorkbench, reloadUi } = useWorkbenchReload({ client, requireHost, addEvent, setNotice });

  const actions: WorkbenchActions = useMemo(() => ({
    openPanel,
    openCommandPalette: () => setPaletteOpen(true),
    openSettings: (page) => setSettingsPage(page ?? "defaults"),
    newSession: () => setNewThreadOpen(true),
    switchSession,
    settleActiveThread,
    // Escape is bound to this; only a visibly running thread has anything to stop.
    abort: () => { if (isVisibleThreadRunning()) void client?.abort(threadStore.getSnapshot().activeThreadId || undefined); },
    reloadWorkbench,
    openThreadTree,
    duplicateThread,
    focusComposer: (seed) => { if (seed !== undefined) setComposerSeed(seed); composerRef.current?.focus(); },
    focusTranscript: () => { (document.querySelector<HTMLElement>(".virtual-transcript") ?? transcriptRef.current ?? (document.querySelector(".transcript-viewport") as HTMLElement | null))?.focus(); },
    focusStage: () => { (document.querySelector(".stage-body, .stage, .stage-container") as HTMLElement | null)?.focus(); },
    toggleDock: () => { setDockOpen((open) => !open); },
    notify: setNotice,
    openProjectSources: () => { setNewThreadOpen(false); setProjectSourcesOpen(true); },
    applyHostResult,
    copyText: async (text: string) => { await platform.clipboard.writeText(text); },
    openExternal: (url: string) => platform.openExternal(url),
    openOverlay: (id) => setActiveOverlayId(id),
    closeOverlay: () => setActiveOverlayId(undefined),
    openWorkspace,
    activeThread: () => ({
      sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
      cwd: workspaceCwd,
      workspaceId: pendingNewThread?.workspaceId ?? snapshot?.workspaceId,
      model: snapshot?.model,
      ...(snapshot?.backendKind ? { backendKind: snapshot.backendKind } : {}),
      draftPending: newThreadDeliveryPending,
    }),
    openFile,
    openThread,
    runShellAction: threadCommands.runShellAction,
    holdComposer: () => { setComposerHolds((count) => count + 1); return () => setComposerHolds((count) => Math.max(0, count - 1)); },
    composerDraft: () => activeDraftKey ? composerScopeStore.getSnapshot(activeDraftKey).draft : "",
  }), [
    applyHostResult, client, openPanel, openThread, activeDraftKey, openWorkspace,
    reloadWorkbench, settleActiveThread, snapshot, switchSession, openThreadTree, duplicateThread,
  ]);

  // Extension commands outlive the render that produced them, so they reach
  // this render's actions through a ref written after the commit.
  useEffect(() => {
    actionsRef.current = actions;
    clientRef.current = client;
  }, [actions, client]);

  // Extensions own every chord; core only dispatches. A handler that already
  // claimed the key (the composer's menu, a dialog) keeps it, and bare keys
  // such as Escape stay with an open modal.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const match = registry.matchKeybinding(event);
      if (!match) return;
      if (!match.modified && document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      Promise.resolve(match.command.run(actions)).catch((error) => setNotice(`${match.command.id}: ${errorMessage(error)}`));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [actions, registry]);

  useEffect(() => {
    const sessionId = snapshot?.sessionId;
    if (!sessionId || turnActivitySessionId !== sessionId) return;
    writeCachedTurnActivity(clientStorage, {
      sessionId,
      tools: [...tools],
      anchorMessageId: toolAnchorId,
    });
  }, [snapshot?.sessionId, toolAnchorId, tools, turnActivitySessionId]);
  const activityTools = useMemo(() => tools.filter((tool) => tool.name !== "todo"), [tools]);

  const liveSnapshot = useMemo(
    () => snapshot ? { ...snapshot, isStreaming: visibleStreaming } : undefined,
    [snapshot, visibleStreaming],
  );
  const stageTab = activeStageTab(stage);
  const stageFilePath = stageTabPath(stageTab);
  const contextValue = useMemo(
    () => ({ snapshot: liveSnapshot, tools, events, registry, activeDocumentPath: stageFilePath, openFile, applySnapshot, handleHostEvent }),
    [liveSnapshot, tools, events, registry, stageFilePath, openFile, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot: liveSnapshot, registry }), [liveSnapshot, registry]);
  const observatoryContextValue = useMemo(() => ({ events, snapshot: liveSnapshot, tools, registry }), [events, liveSnapshot, tools, registry]);
  // The stage shows documents; whoever registered the document source loads them.
  const documentSource = registry.getDocumentSource();
  const documentState = useSyncExternalStore(documentSource?.subscribe ?? noopSubscribe, documentSource?.getState ?? emptyDocumentState, documentSource?.getState ?? emptyDocumentState);
  const sidebarContributions = registry.getSidebarContributions();
  const commands = registry.getCommands();
  const titleCommands = registry.getCommandsFor("thread-title");
  const preparedThreadCapability = usePreparedThreadCapability(
    pendingNewThread?.sessionId ? undefined : pendingNewThread?.projectPath,
    client?.getPreparedThreadCapability,
  );
  // Two facts about the conversation, not its rows: a streamed delta leaves
  // both unchanged, so the store hands back the same value and nothing here
  // re-renders. The transcript itself subscribes inside the workbench.
  const conversation = useSyncExternalStore(
    viewStore.subscribeToConversation,
    () => viewStore.selectConversation(activeDraftKey, Boolean(pendingNewThread)),
  );
  const visibleToolAnchorId = visibleStreaming
    ? conversation.lastMessageId
    // A submitted prompt is visible before its run starts. Keep the previous
    // settled group on its original turn until agent-status opens new work.
    : toolAnchorId ?? conversation.lastMessageId;
  const conversationSnapshot = useMemo(() => pendingNewThread && snapshot ? {
    ...snapshot,
    cwd: pendingNewThread.projectPath,
    // A draft is a semantic scope, not a Pi session. The session ID remains
    // the last real runtime while the draft ID travels in TranscriptTurnStart.
    sessionName: undefined,
    sessionTitle: "Untitled thread",
    isStreaming: false,
    ...(pendingNewThread.model ? { model: pendingNewThread.model } : {}),
    supportsImageInput: pendingNewThread.sessionId
      ? snapshot.sessionId === pendingNewThread.sessionId && snapshot.supportsImageInput === true
      : preparedThreadCapability?.cwd === pendingNewThread.projectPath
        ? preparedThreadCapability.supportsImageInput ?? false
        : false,
    taskProgress: undefined,
    taskHistory: [],
  } : snapshot ? { ...snapshot, isStreaming: visibleStreaming } : snapshot,
  [pendingNewThread, snapshot, visibleStreaming, preparedThreadCapability]);
  const addDroppedFiles = useCallback((files: FileList | readonly File[]) => {
    void composerAttachmentRef.current?.addFiles(files);
  }, []);
  const composerScopeSubscribe = useCallback((onChange: () => void) => activeDraftKey
    ? composerScopeStore.subscribe(createDraftKey(activeDraftKey), onChange)
    : () => {}, [activeDraftKey, composerScopeStore]);
  const composerAttachmentSnapshot = useSyncExternalStore(
    composerScopeSubscribe,
    useCallback(() => activeDraftKey
      ? composerScopeStore.getAttachmentSnapshot(createDraftKey(activeDraftKey))
      : EMPTY_COMPOSER_ATTACHMENTS, [activeDraftKey, composerScopeStore]),
  );
  const threadDropController = useThreadDropController(
    conversationSnapshot?.supportsImageInput ?? false,
    addDroppedFiles,
    composerAttachmentSnapshot.attachments,
  );
  const { conversationActivityTools, conversationPrompts, liveStatusLabel, transcriptActivities } = useConversationActivities({
    pendingNewThread: Boolean(pendingNewThread), activityTools, turnActivityHistory, conversationSnapshot,
    toolAnchorId, visibleToolAnchorId, threadPrompts, registry, registryVersion,
    viewStore, actions, detail: preferences.transcriptDetailFor(conversationSnapshot?.sessionId),
    recoverThread: threadCommands.recoverThread, copyToolOutput: threadCommands.copyToolOutput, abortSessionId: snapshot?.sessionId,
    abort: abortThread,
  });
  const showStartScreen = conversation.isEmpty
    && !conversationSnapshot?.isStreaming
    && conversationActivityTools.length === 0
    && conversationPrompts.length === 0;
  const startProjectPath = conversationSnapshot?.cwd ?? "";
  const startProjectName = pendingNewThread?.projectName
    ?? projects.find((project) => project.path === startProjectPath)?.name
    ?? startProjectPath.split(/[\\/]/u).filter(Boolean).at(-1)
    ?? startProjectPath;
  const layout = useMemo<WorkbenchLayout>(() => ({
    registry, threadStore, settings, layoutProfile, workspaceCwd, sidebarContributions, panels, activePanel,
    openedPanels, openPanel, dockOpen, setDockOpen, centerRef, centerCompact, setCenterCompact,
    chatFocused, setChatFocused, stage, activateStageTab: activateStage, closeStageTab: closeStage,
    pinStageTab: pinStage, setStageFileView: setStageView, loadThread: threadCommands.loadThread, takeOverThread, documentState, documentSource, visibleStreaming, paletteOpen, closePalette,
    commands, projectSourcesOpen, closeProjectSources, newThreadOpen, openNewThreadPicker,
    closeNewThreadPicker, projects, removeProject: threadCommands.removeProject, createThreadInProject, settingsPage, setSettingsPage,
    notice: notice?.message, noticeLevel: notice?.level ?? "info", setNotice, activeOverlayId, closeOverlay,
  }), [
    activePanel, activeOverlayId, activateStage, centerCompact, chatFocused, closeNewThreadPicker, layoutProfile,
    closeOverlay, closePalette, closeProjectSources, closeStage, commands, createThreadInProject,
    documentSource, documentState, dockOpen, newThreadOpen, notice, openNewThreadPicker, openPanel,
    threadCommands, openedPanels, paletteOpen, panels, pinStage, projectSourcesOpen, projects, registry,
    setNotice, setStageView, settings, settingsPage,
    sidebarContributions, stage, takeOverThread, threadStore, visibleStreaming, workspaceCwd,
  ]);

  const thread = useMemo<WorkbenchThread>(() => ({
    snapshot: liveSnapshot, conversationSnapshot, pendingNewThread: Boolean(pendingNewThread),
    showStartScreen, startProjectPath, startProjectName, dropController: threadDropController,
    transcriptHistory, transcriptRef, loadTranscriptPage: threadCommands.loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptScope, transcriptTurnStart, visibleTranscriptTurnStart, transcriptActivities,
    liveStatusLabel, conversationActivityTools, runStartedAt, activeDraftKey, copyMessage, forkMessage: threadCommands.forkMessage,
    titleCommands, openThreadTree, duplicateThread, settleActiveThread, renameThread: threadCommands.renameThread, copyThreadValue: threadCommands.copyThreadValue,
    threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  }), [
    activeDraftKey, applyTranscriptPage, closeThreadTree, conversationActivityTools,
    conversationSnapshot, threadCommands, copyMessage, duplicateThread, forkFromTree,
    liveSnapshot, liveStatusLabel, navigateThreadTree, openThreadTree,
    pendingNewThread, runStartedAt, settleActiveThread, showStartScreen,
    startProjectName, startProjectPath, threadDropController, threadTreeModal, titleCommands,
    transcriptActivities, transcriptHistory, transcriptScope, transcriptScopeKey, transcriptTurnStart,
    visibleTranscriptTurnStart,
  ]);

  const setComposerModel = useCallback(async (provider: string, id: string) => {
    const pending = currentPendingNewThread();
    if (!pending || pending.sessionId) {
      await threadCommands.setModel(provider, id);
      return;
    }
    const selected = viewStore.getSnapshot()?.models.find((model) => model.provider === provider && model.id === id);
    const next = { ...pending, model: { provider, id, name: selected?.name ?? id } };
    writeNewThreadDraft(clientStorage, next);
    setPendingNewThread(next);
  }, [clientStorage, currentPendingNewThread, setPendingNewThread, threadCommands, viewStore]);

  const composer = useMemo<WorkbenchComposer>(() => ({
    scopeStore: composerScopeStore, seed: composerSeed, textareaRef: composerRef,
    attachmentRef: composerAttachmentRef, queue, holds: composerHolds, prompts: conversationPrompts,
    submit: submitPrompt, abort: abortThread,
    cancelQueued, steerQueued, reorderQueue, setModel: setComposerModel, setThinking: threadCommands.setThinking,
    answerUiPrompt: threadCommands.answerUiPrompt, compactContext: threadCommands.compactContext,
  }), [
    abortThread, cancelQueued, threadCommands, composerHolds, composerScopeStore, composerSeed,
    conversationPrompts, queue, reorderQueue, setComposerModel, steerQueued, submitPrompt,
  ]);

  const workbenchModel = useMemo<WorkbenchModel>(() => ({
    view: viewStore, actions, context: contextValue, shellContext: shellContextValue,
    observatoryContext: observatoryContextValue, layout, thread, composer,
  }), [actions, composer, contextValue, layout, observatoryContextValue, shellContextValue, thread, viewStore]);

  return <PlatformProvider platform={platform}>
    <Workbench model={workbenchModel} />
    {updateReady ? <UpdateToast
      version={updateReady}
      onRestart={() => { void client?.installUpdate(); }}
      onDismiss={() => setUpdateReady(undefined)}
    /> : null}
    {reloadUi}
  </PlatformProvider>;
}
