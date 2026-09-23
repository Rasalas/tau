import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HostEvent, UiMessage } from "../shared/contracts";
import type { UiEditor, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { mockSnapshot, mockThreadIndex, reconcileOptimisticMessages, transcriptNavigationScope, transcriptNavigationScopeKey } from "../workbench/app-state";
import { WorkbenchSession } from "../workbench/workbench-session";
import { ThreadCommands } from "../workbench/thread-commands";
import { useThreadNavigation } from "./use-thread-navigation";
import { useThreadTree } from "./use-thread-tree";
import { readBootstrapCache } from "../workbench/bootstrap-cache";
import { type ComposerAttachmentHandle, type ComposerControlHandle } from "./components/Composer";
import { visibleUserMessageText } from "./components/MessageText";
import { UpdateToast } from "./components/UpdateToast";
import { createDraftKey } from "../workbench/composer-scope-store";
import { hasActivityTools } from "./conversation-activities";
import { draftKey, writeNewThreadDraft } from "../workbench/draft-store";
import { errorMessage } from "../workbench/error-message";
import { ExtensionRegistry, hostExtensionBridge, type WorkbenchActions } from "./extension-system";
import { runtimeControls } from "./settings/runtime-controls";
import { FollowUpQueueStore } from "../workbench/follow-up-queue";
import { useHostClient } from "./host-client-context";
import { useClientStorage } from "./client-storage-context";
import { applyHostEvent, type HostEventTargets } from "../workbench/host-events";
import { getPlatform, PlatformProvider, setPlatform } from "./platform-context";
import { useAppOverlays } from "./use-app-overlays";
import { useAppKeybindings } from "./use-app-keybindings";
import { useWorkbenchActions } from "./use-workbench-actions";
import { useClientEnvironment } from "./client-environment";
import { useLayoutProfile } from "./use-layout-profile";
import { HOST_CAPABILITY } from "../shared/host-transport";
import { usePreferences, useRendererServices } from "./renderer-services-context";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { activeTab as activeStageTab, openFileTab, openThreadTab, stageTabPath, type StageView } from "../workbench/stage";
import { useStageTabs } from "./stage-tab-controller";
import { useWorkbenchLayoutState } from "./use-workbench-layout-state";
import { SubmissionController, type SubmissionControllerPorts } from "./submission-controller";
import { followTurnActivity } from "../workbench/turn-activity";
import { useFollowUpQueue, type SubmitPrompt } from "./use-follow-up-queue";
import { usePreparedThreadCapability } from "./use-prepared-thread-capability";
import { useThreadDropController } from "./use-thread-drop-controller";
import { useWorkbenchReload } from "./use-workbench-reload";
import { Workbench, type WorkbenchComposer, type WorkbenchControlHandle, type WorkbenchLayout, type WorkbenchModel, type WorkbenchThread } from "./Workbench";

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
  const actionsRef = useRef<WorkbenchActions | undefined>(undefined);
  const clientRef = useRef(client);
  // The session is built before the layout state exists, and a project change
  // reaches it from there; the ref is the one hop between them.
  const resetStageRef = useRef<() => void>(() => {});
  const [registry] = useState(() => {
    const value = new ExtensionRegistry(hostExtensionBridge(client), { preferences, profile, platform: getPlatform });
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
  const [workbenchSession] = useState(() => new WorkbenchSession({
    storage: clientStorage,
    cached: cachedBootstrap,
    onProjectChange: () => resetStageRef.current(),
    notification: {
      notifyPromptSubmitted: (event) => {
        const actions = actionsRef.current;
        if (!actions) return false;
        return registry.notifyPromptSubmitted(event, actions);
      },
    },
  }));
  const {
    view: viewStore, threads: threadStore, history: transcriptHistory,
    scopes: composerScopeStore, hostSession, turn: turnScope,
    newThread: newThreadController, delivery: newThreadDelivery,
  } = workbenchSession;
  const { applySnapshot, applyThreadIndex, applyTranscriptPage, applyHostUpdate, applyActionResult } = workbenchSession;
  // Extensions from ~/.tau/extensions and <project>/.tau/extensions load at
  // runtime, like Pi's own; the project set follows the open workspace.
  const [runtimeExtensions] = useState(() => {
    installSharedModules();
    return new RuntimeExtensions(registry, {
      load: (cwd, sharedExports, only) => client
        ? client.loadDesktopExtensions(cwd, sharedExports, only)
        : Promise.resolve({ bundles: [], errors: [], skipped: [] }),
      isEnabled: (id) => preferences.isExtensionEnabled(id),
      notify: (message) => viewStore.setNotice(message),
      log: (label, detail) => viewStore.addEvent(label, detail),
    });
  });
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const threadActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);

  const snapshot = useSyncExternalStore(viewStore.subscribeToSnapshot, viewStore.getSnapshot);
  // Tool runs render in the transcript, which subscribes itself; here only
  // whether there are any, which a stream of output never changes.
  const turnHasActivity = useSyncExternalStore(viewStore.subscribeToTools, () => hasActivityTools(viewStore));
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
  const {
    paletteOpen, openPalette, closePalette,
    newThreadOpen, openNewThreadPicker, closeNewThreadPicker,
    projectSourcesOpen, openProjectSources, closeProjectSources,
    activeOverlayId, openOverlay, closeOverlay,
    settingsPage, setSettingsPage,
  } = useAppOverlays();
  const pendingNewThread = useSyncExternalStore(newThreadController.subscribe, newThreadController.current);
  const {
    set: setPendingNewThread, begin: beginNewThread, invalidate: invalidateNewThread,
    isCurrent: isCurrentNewThreadRequest, markAwaitingPromotion,
    promoteFromUserMessage, current: currentPendingNewThread,
  } = newThreadController;
  // A prepared thread is not a runtime session yet, so its project is the
  // only trustworthy workspace identity while it is on screen. In
  // particular, do not expose the last real thread's worktree in the chrome.
  const workspaceCwd = safeMode ? undefined : (pendingNewThread?.projectPath ?? snapshot?.cwd);
  const activeWorkspaceId = pendingNewThread?.workspaceId ?? snapshot?.workspaceId;
  const knownThreadIds = useSyncExternalStore(threadStore.subscribeToIds, threadStore.getThreadIds);
  const panels = registry.getPanels();
  const panelIds = useMemo(() => panels.map((panel) => panel.id), [panels]);
  // The stage and the dock belong to the workspace, and outlive the window.
  const {
    stage, setStage, dockOpen, setDockOpen, activePanel, setActivePanel,
    openedPanels, dockWidth, setDockWidth, resetStage,
  } = useWorkbenchLayoutState({
    storage: clientStorage,
    // A host that mints workspace ids names the workspace that way; one that
    // does not leaves its path, which is what the review state falls back to too.
    workspaceKey: activeWorkspaceId ?? workspaceCwd,
    workspacePath: workspaceCwd,
    knownThreadIds,
    panelIds,
  });
  useEffect(() => { resetStageRef.current = resetStage; }, [resetStage]);
  const openedPanelIds = useMemo(() => new Set(openedPanels), [openedPanels]);
  // Stage tabs a kit drew: their handles, and the one door that closes a tab.
  const stageTabs = useStageTabs({ registry, registryVersion, stage, setStage });
  // Below this many pixels the centre cannot hold chat and stage side by side;
  // the chat then joins the stage's tab strip instead of losing the thread list.
  const [centerCompact, setCenterCompact] = useState(false);
  const [chatFocused, setChatFocused] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);
  const [composerHolds, setComposerHolds] = useState(0);
  const [composerSeed, setComposerSeed] = useState<string>();
  const newThreadDeliveryPending = Boolean(pendingNewThread);
  /** The version the host downloaded; the toast that offers the restart reads it. */
  const [updateReady, setUpdateReady] = useState<string>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachmentRef = useRef<ComposerAttachmentHandle>(null);
  const composerControlRef = useRef<ComposerControlHandle>(null);
  const workbenchControlRef = useRef<WorkbenchControlHandle>(null);
  const openModelPicker = useCallback(() => composerControlRef.current?.openModelPicker(), []);
  const openInstructions = useCallback(() => workbenchControlRef.current?.openInstructions(), []);
  const focusStage = useCallback(() => workbenchControlRef.current?.focusStage(), []);
  const toggleSidebar = useCallback(() => workbenchControlRef.current?.toggleSidebar(), []);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
  /** The draft key as of now, for the async paths that must not read a rendered value. */
  const currentDraftKey = useCallback(
    () => draftKey(viewStore.getSnapshot()?.sessionId, currentPendingNewThread()),
    [currentPendingNewThread, viewStore],
  );
  const currentSessionId = useCallback(() => viewStore.getSnapshot()?.sessionId, [viewStore]);
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
  const transcriptTurnStart = useSyncExternalStore(turnScope.subscribe, turnScope.current);
  useEffect(() => {
    turnScope.commitScope(transcriptScopeKey);
  }, [turnScope, transcriptScopeKey]);
  const visibleTranscriptTurnStart = transcriptTurnStart?.scopeKey === transcriptScopeKey
    ? transcriptTurnStart
    : undefined;
  const [followUpQueue] = useState(() => new FollowUpQueueStore());
  // Renderer prompt contributions adapt to the already-constructed session.
  // Host updates and delivery no longer call back through this controller.
  const [submission] = useState<SubmissionController>(() => {
    const ports: SubmissionControllerPorts = {
      client: () => clientRef.current,
      view: viewStore,
      threads: threadStore,
      scopes: composerScopeStore,
      registry,
      storage: clientStorage,
      preferences,
      hostSession,
      delivery: newThreadDelivery,
      notify: (message) => viewStore.setNotice(message),
      actions: () => actionsRef.current,
      newThread: {
        current: currentPendingNewThread,
        set: (draft) => setPendingNewThread(draft),
        update: (change) => setPendingNewThread((current) => change(current)),
        requestId: newThreadController.requestId,
        isCurrent: isCurrentNewThreadRequest,
        markAwaitingPromotion,
        promoteFromUserMessage,
      },
      turn: turnScope,
      host: workbenchSession,
      enqueueFollowUp: (threadId, item) => followUpQueue.enqueue(threadId, item),
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
    activateStage, pinStage, unpinStage, setStageView, cycleStageTab,
    applyHostResult, openWorkspace, createThreadInProject, switchSession, takeOverThread,
  } = useThreadNavigation({
    ...(client ? { client } : {}),
    storage: clientStorage,
    view: viewStore,
    threads: threadStore,
    history: transcriptHistory,
    scopes: composerScopeStore,
    workbench: workbenchSession,
    stage, setStage,
    requireHost,
    detachPendingDelivery: newThreadDelivery.detachPendingDelivery,
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

  useEffect(() => {
    if (!client) return;
    if (workspaceCwd) void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
    // A project's own settings apply from the start screen on, before its thread has a workspace id.
    preferences.setWorkspace(activeWorkspaceId ?? workspaceCwd);
  }, [activeWorkspaceId, client, preferences, runtimeExtensions, workspaceCwd]);
  const syncDesktopExtensions = useCallback((only?: readonly string[]) => {
    void runtimeExtensions.resync(only).catch((error) => setNotice(errorMessage(error)));
  }, [runtimeExtensions, setNotice]);

  const hostEventTargets = useMemo<HostEventTargets>(() => ({
    client, registry, threadStore, view: viewStore, submission: newThreadDelivery, preferences,
    viewerHidden: () => document.hidden, currentDraftKey,
    transcriptTurnStart: turnScope.current,
    setTranscriptTurnStart: turnScope.set, applyHostUpdate, applyThreadIndex,
    syncDesktopExtensions, setUpdateReady, setNotice,
  }), [
    client, currentDraftKey, preferences, registry, setNotice,
    newThreadDelivery, syncDesktopExtensions, threadStore, turnScope, viewStore,
  ]);
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
        workbenchSession.applyBootstrap(bootstrap, bootstrapRequest);
      }).catch((error) => {
        if (transcriptHistory.isCurrentBootstrap(bootstrapRequest)) setNotice(errorMessage(error));
      });
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, client, handleHostEvent, transcriptHistory, workbenchSession]);

  const activeThreadIdForEvents = snapshot?.sessionId;
  useEffect(() => {
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: activeThreadIdForEvents });
  }, [activeThreadIdForEvents, registry]);

  // The project the host has open, as the workbench's own event: a panel reacts
  // to a project change without asking the host what changed.
  const hostWorkspace = snapshot?.cwd;
  const lastWorkspace = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!hostWorkspace || hostWorkspace === lastWorkspace.current) return;
    const from = lastWorkspace.current;
    lastWorkspace.current = hostWorkspace;
    registry.dispatchWorkbenchEvent({ type: "workspace-changed", ...(from ? { from } : {}), to: hostWorkspace });
  }, [hostWorkspace, registry]);

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

  const openPanel = useCallback((id: string) => {
    setActivePanel(id);
    setDockOpen(true);
  }, [setActivePanel, setDockOpen]);
  const openFile = useCallback((path: string, options?: { pin?: boolean; view?: StageView; line?: number }) => { setStage((current) => openFileTab(current, path, options)); setChatFocused(false); }, []);
  const openThread = useCallback((sessionId: string, options?: { pin?: boolean }) => { setStage((current) => openThreadTab(current, sessionId, options)); setChatFocused(false); }, []);
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

  const setComposerModel = useCallback(
    (provider: string, id: string) => newThreadController.setModel(
      provider, id, threadCommands.setModel,
      (p, mid) => viewStore.getSnapshot()?.models.find((m) => m.provider === p && m.id === mid)?.name,
    ),
    [newThreadController, threadCommands, viewStore],
  );
  const actions = useWorkbenchActions({
    client, platform, threadStore, viewStore, composerScopeStore, threadCommands,
    snapshot, pendingNewThread, workspaceCwd, newThreadDeliveryPending, activeDraftKey,
    composerRef, transcriptRef, openPanel, openPalette, setSettingsPage, openNewThreadPicker, createThreadInProject,
    switchSession, settleActiveThread, isVisibleThreadRunning, reloadWorkbench, openThreadTree,
    duplicateThread, setComposerSeed, setDockOpen, setNotice, openProjectSources,
    applyHostResult, stageTabs, cycleStageTab, openOverlay, closeOverlay,
    openWorkspace, openFile, openThread, setComposerHolds, setComposerModel, preferences,
    openModelPicker, openInstructions, focusStage, toggleSidebar,
    executeCommand: (id) => {
      if (!actionsRef.current) throw new Error("Actions are not ready yet.");
      return registry.executeCommand(id, actionsRef.current);
    },
  });

  // Extension commands outlive the render that produced them, so they reach
  // this render's actions through a ref written after the commit.
  useEffect(() => {
    actionsRef.current = actions;
    clientRef.current = client;
  }, [actions, client]);

  useAppKeybindings(registry, actions, setNotice);

  useEffect(() => followTurnActivity(viewStore, clientStorage), [clientStorage, viewStore]);

  const liveSnapshot = useMemo(
    () => snapshot ? { ...snapshot, isStreaming: visibleStreaming } : undefined,
    [snapshot, visibleStreaming],
  );
  const stageTab = activeStageTab(stage);
  const stageFilePath = stageTabPath(stageTab);
  // The workbench adds the tool runs to both contexts itself.
  const contextValue = useMemo(
    () => ({ snapshot: liveSnapshot, events, registry, activeDocumentPath: stageFilePath, openFile, applySnapshot, handleHostEvent }),
    [liveSnapshot, events, registry, stageFilePath, openFile, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot: liveSnapshot, registry, actions }), [actions, liveSnapshot, registry]);
  const observatoryContextValue = useMemo(() => ({ events, snapshot: liveSnapshot, registry }), [events, liveSnapshot, registry]);
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
    registry.getComposerInlines().some((inline) => inline.takeFiles !== undefined),
  );
  const conversationPrompts = useMemo(() => pendingNewThread ? [] : threadPrompts, [pendingNewThread, threadPrompts]);
  const showStartScreen = conversation.isEmpty && !conversationSnapshot?.isStreaming && (Boolean(pendingNewThread) || !turnHasActivity) && conversationPrompts.length === 0;
  const startProjectPath = conversationSnapshot?.cwd ?? "";
  const startProjectName = pendingNewThread?.projectName ?? projects.find((project) => project.path === startProjectPath)?.name ?? startProjectPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? startProjectPath;
  const layout = useMemo<WorkbenchLayout>(() => ({
    controlRef: workbenchControlRef,
    registry, threadStore, settings, layoutProfile, workspaceCwd, sidebarContributions, panels, activePanel,
    openedPanels: openedPanelIds, openPanel, dockOpen, setDockOpen, dockWidth, onDockWidthChange: setDockWidth,
    centerRef, centerCompact, setCenterCompact,
    chatFocused, setChatFocused, stage, stageTabs, activateStageTab: activateStage,
    pinStageTab: pinStage, unpinStageTab: unpinStage, setStageFileView: setStageView, loadThread: threadCommands.loadThread, takeOverThread, documentState, documentSource, visibleStreaming, paletteOpen, closePalette,
    commands, projectSourcesOpen, closeProjectSources, newThreadOpen, openNewThreadPicker,
    closeNewThreadPicker, projects, removeProject: threadCommands.removeProject, createThreadInProject, settingsPage, setSettingsPage,
    notice: notice?.message, noticeLevel: notice?.level ?? "info", setNotice, activeOverlayId, closeOverlay,
  }), [
    activePanel, activeOverlayId, activateStage, centerCompact, chatFocused, closeNewThreadPicker, layoutProfile,
    closeOverlay, closePalette, closeProjectSources, commands, createThreadInProject,
    documentSource, documentState, dockOpen, dockWidth, setDockOpen, setDockWidth, newThreadOpen, notice,
    openNewThreadPicker, openPanel, openedPanelIds,
    threadCommands, paletteOpen, panels, pinStage, projectSourcesOpen, projects, registry,
    setNotice, setStageView, settings, settingsPage, stageTabs, unpinStage,
    sidebarContributions, stage, takeOverThread, threadStore, visibleStreaming, workspaceCwd,
  ]);

  const thread = useMemo<WorkbenchThread>(() => ({
    snapshot: liveSnapshot, conversationSnapshot, pendingNewThread: Boolean(pendingNewThread),
    showStartScreen, startProjectPath, startProjectName, dropController: threadDropController,
    transcriptHistory, transcriptRef, loadTranscriptPage: threadCommands.loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptScope, transcriptTurnStart, visibleTranscriptTurnStart, lastMessageId: conversation.lastMessageId,
    recoverThread: threadCommands.recoverThread, copyToolOutput: threadCommands.copyToolOutput, loadToolOutput: threadCommands.loadToolOutput,
    runStartedAt, activeDraftKey, copyMessage, forkMessage: threadCommands.forkMessage,
    titleCommands, openThreadTree, duplicateThread, settleActiveThread, renameThread: threadCommands.renameThread, copyThreadValue: threadCommands.copyThreadValue,
    threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  }), [
    activeDraftKey, applyTranscriptPage, closeThreadTree, conversation.lastMessageId, conversationSnapshot,
    threadCommands, copyMessage, duplicateThread, forkFromTree, liveSnapshot, navigateThreadTree,
    openThreadTree, pendingNewThread, runStartedAt, settleActiveThread, showStartScreen, startProjectName,
    startProjectPath, threadDropController, threadTreeModal, titleCommands,
    transcriptHistory, transcriptScope, transcriptScopeKey, transcriptTurnStart, visibleTranscriptTurnStart,
  ]);

  const composer = useMemo<WorkbenchComposer>(() => ({
    controlRef: composerControlRef,
    scopeStore: composerScopeStore, seed: composerSeed, textareaRef: composerRef,
    attachmentRef: composerAttachmentRef, queue, holds: composerHolds, prompts: conversationPrompts,
    submit: submitPrompt, abort: abortThread, cancelQueued, steerQueued, reorderQueue,
    setModel: setComposerModel, setThinking: threadCommands.setThinking,
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
