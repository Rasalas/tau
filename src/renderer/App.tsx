import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppUpdatePhase, HostEvent, UiMessage } from "../shared/contracts";
import type { UiEditor, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { mockSnapshot, mockThreadIndex, reconcileOptimisticMessages, transcriptNavigationScope, transcriptNavigationScopeKey } from "../workbench/app-state";
import { WorkbenchSession } from "../workbench/workbench-session";
import { ThreadCommands } from "../workbench/thread-commands";
import { useThreadNavigation, type ShowThreadOptions } from "./use-thread-navigation";
import { useThreadTree } from "./use-thread-tree";
import { readBootstrapCache } from "../workbench/bootstrap-cache";
import { type ComposerAttachmentHandle, type ComposerControlHandle } from "./components/Composer";
import { visibleUserMessageText } from "./components/MessageText";
import { useWorkbenchToasts } from "./use-workbench-toasts";
import { useWindowShell } from "./use-window-shell";
import { createDraftKey } from "../workbench/composer-scope-store";
import { hasActivityTools } from "./conversation-activities";
import { draftKey, writeNewThreadDraft } from "../workbench/draft-store";
import { errorMessage } from "../workbench/error-message";
import { ExtensionRegistry, hostExtensionBridge, type WorkbenchActions } from "./extension-system";
import { runtimeControls } from "./settings/runtime-controls";
import { followExtensionChoices } from "./extension-choices";
import { useHostClient } from "./host-client-context";
import { useClientStorage } from "./client-storage-context";
import { applyHostEvent, type HostEventTargets, type PackagesChangeReport } from "../workbench/host-events";
import { getPlatform, PlatformProvider, setPlatform } from "./platform-context";
import { useAppOverlays } from "./use-app-overlays";
import { useAppKeybindings } from "./use-app-keybindings";
import { useWorkbenchActions } from "./use-workbench-actions";
import { useClientEnvironment } from "./client-environment";
import { useLayoutProfile } from "./use-layout-profile";
import { primaryPointerIsTouch } from "./touch-input";
import { HOST_CAPABILITY } from "../shared/host-transport";
import { usePreferences, useRendererServices } from "./renderer-services-context";
import { AppUpdateStore } from "./app-update";
import { effectiveNewThreadRuntime } from "./new-thread-runtime";
import { selectionOnScreen } from "../workbench/new-thread-project";
import { useRuntimeCatalog } from "./use-runtime-catalog";
import { draftRuntimeSnapshot } from "../workbench/runtime-catalog-store";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { openFileTab, openThreadTab, stageFilePath as projectFilePath, type StageView } from "../workbench/stage";
import { useWorkspaceResourceNavigation } from "./workspace-resource-navigation";
import { machineThreadPath } from "./machine-thread-navigation";
import { lookInMachine } from "../workbench/look-in";
import { useStageTabs } from "./stage-tab-controller";
import { useWorkbenchLayoutState } from "./use-workbench-layout-state";
import { stageOwner } from "../workbench/thread-stages";
import { usePanelLayout } from "./use-panel-layout";
import type { SubmissionControllerPorts } from "./submission-controller";
import { deferredSubmission } from "./deferred-submission";
import { followTurnActivity } from "../workbench/turn-activity";
import { followWorkbenchBootstrap } from "../workbench/workbench-bootstrap";
import { followOpenPrompts } from "../workbench/open-prompts";
import { returnToComposer, useFollowUpQueue, type SubmitPrompt } from "./use-follow-up-queue";
import { usePreparedThreadCapability } from "./use-prepared-thread-capability";
import { useThreadDropController } from "./use-thread-drop-controller";
import { usePendingAttachments } from "./use-pending-attachments";
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
  const services = useRendererServices();
  const constructedExtensions = services.extensions;
  // Which client this is, whether kits were left out, and how to reach this
  // machine: the entry point decided all three before the first render.
  const { profile, safeMode, createPlatform } = useClientEnvironment();
  // What the client claims never moves; how wide it is does.
  const layoutProfile = useLayoutProfile(profile);
  const cachedBootstrap = useMemo(() => readBootstrapCache(clientStorage), [clientStorage]);
  const actionsRef = useRef<WorkbenchActions | undefined>(undefined);
  const clientRef = useRef(client);
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
    settledThreadIds: () => preferences.getSnapshot().settledThreadIds,
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
      toast: (options) => workbenchSession.toasts.show(options),
      openSettings: (target) => actionsRef.current?.openSettings(target),
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
  const events = useSyncExternalStore(viewStore.subscribeToEvents, viewStore.getEvents);
  const setNotice = viewStore.setNotice;
  const addEvent = viewStore.addEvent;
  // A switch on any device reaches this one: the host's list is every client's.
  useEffect(() => safeMode ? undefined : followExtensionChoices(registry, preferences, addEvent), [registry, preferences, safeMode, addEvent]);
  // Run state lives in the thread store, fed by the host's per-thread status
  // events. Every other reading of "is this thread working" is this selector,
  // so the composer, the live row and the rail cannot disagree.
  const visibleStreaming = threadActivity.isStreaming;
  const runStartedAt = threadActivity.runningStartedAt[threadActivity.activeThreadId];
  // Only the user-message slice of the transcript reaches this component: a
  // streamed delta must re-render the transcript and nothing above it.
  const transcriptUserRevision = useSyncExternalStore(viewStore.subscribeToUserMessages, viewStore.getUserRevision);
  const {
    paletteOpen, paletteMenu, openPalette, closePalette,
    newThreadPick, openNewThreadPicker, closeNewThreadPicker,
    projectSourcesOpen, projectSource, openProjectSources, closeProjectSources,
    activeOverlayId, openOverlay, closeOverlay,
    settingsPage, setSettingsPage, pages,
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
  // A draft without an id is keyed by its path, never by the host's project.
  const activeWorkspaceId = pendingNewThread ? pendingNewThread.workspaceId : snapshot?.workspaceId;
  const knownThreadIds = useSyncExternalStore(threadStore.subscribeToIds, threadStore.getThreadIds);
  const panels = registry.getPanels();
  const panelIds = useMemo(() => panels.filter((panel) => panel.placement !== "drawer").map((panel) => panel.id), [panels]);
  // The stage and the dock belong to the thread or draft on screen, and outlive the window.
  const shownOwner = stageOwner(snapshot?.sessionId, pendingNewThread);
  const {
    stage, setStage, stageWorkspace, stageMaximized, setStageMaximized, stageFolded, setStageFolded, setStageShown, activePanel, setActivePanel,
    drawer, setDrawer,
  } = useWorkbenchLayoutState({
    storage: clientStorage,
    stages: workbenchSession.stages,
    owner: shownOwner,
    // A host that mints workspace ids names the workspace that way; one that
    // does not leaves its path, which is what the review state falls back to too.
    workspaceKey: activeWorkspaceId ?? workspaceCwd,
    workspacePath: workspaceCwd,
    knownThreadIds,
    panelIds,
  });
  // Stage tabs a kit drew: their handles, and the one door that closes a tab.
  // A document opened beside the chat takes the tool that filled that space into the tabs.
  const revealDocuments = useRef(() => {});
  const stageTabs = useStageTabs({ registry, registryVersion, stage, setStage, onOpen: () => revealDocuments.current() });
  // Where the centre is too narrow for chat and stage side by side, the one in front.
  const [chatFocused, setChatFocused] = useState(false);
  // Another thread's chat is what was asked for, beside its stage even if that was maximized; a restart keeps it.
  const ownerShown = useRef(false);
  useEffect(() => { setChatFocused(true); if (ownerShown.current) setStageMaximized(false); ownerShown.current = Boolean(shownOwner); }, [setStageMaximized, shownOwner]);
  // The stage over the whole centre, the conversation out of sight.
  const maximized = stageMaximized;
  const [composerHolds, setComposerHolds] = useState(0);
  const [composerSeed, setComposerSeed] = useState<string>();
  const newThreadDeliveryPending = Boolean(pendingNewThread);
  // The release the host downloaded; the toast and the sidebar's foot offer the restart.
  const [appUpdate] = useState(() => services.appUpdate ?? new AppUpdateStore());
  const update = useSyncExternalStore(appUpdate.subscribe, appUpdate.getSnapshot);
  const setUpdateReady = useCallback((version: string, phase?: AppUpdatePhase, progress?: number) => appUpdate.set({ version, phase, progress, install: () => { void client?.installUpdate(); } }), [appUpdate, client]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachmentRef = useRef<ComposerAttachmentHandle>(null);
  const composerControlRef = useRef<ComposerControlHandle>(null);
  const workbenchControlRef = useRef<WorkbenchControlHandle>(null);
  const openModelPicker = useCallback(() => composerControlRef.current?.openModelPicker(), []);
  const openInstructions = useCallback(() => workbenchControlRef.current?.openInstructions(), []);
  const focusStage = useCallback(() => workbenchControlRef.current?.focusStage(), []);
  const showThread = useCallback((options?: ShowThreadOptions) => workbenchControlRef.current?.showThread(options), []);
  const toggleSidebar = useCallback(() => workbenchControlRef.current?.toggleSidebar(), []);
  const toggleSpine = useCallback(() => workbenchControlRef.current?.toggleSpine(), []);
  const threadView = useCallback(() => workbenchControlRef.current?.threadView(), []);
  const inheritSelection = useCallback(() => {
    const draft = newThreadController.current();
    newThreadController.inherit(selectionOnScreen({ covered: threadView()?.covered, draft, draftRuntime: effectiveNewThreadRuntime(draft?.runtime ?? preferences.getSnapshot().newThreadRuntime, viewStore.getSnapshot()), thread: viewStore.getSnapshot() }));
  }, [newThreadController, preferences, threadView, viewStore]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const attachFiles = usePendingAttachments(composerAttachmentRef, snapshot?.sessionId);
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
  // Renderer prompt contributions adapt to the already-constructed session.
  // Host updates and delivery no longer call back through this controller.
  const [submission] = useState(() => {
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
      enqueueFollowUp: async (threadId, item) => {
        if (!clientRef.current) throw new Error("Queued messages require the host.");
        await clientRef.current.queueMessage(threadId, item.text, item.attachments, item.skillDraft);
      },
    };
    return deferredSubmission(ports);
  });
  const submitPrompt = useCallback<SubmitPrompt>(
    (text, attachments, delivery, skillDraft) => submission.submit({ text, attachments, delivery, skillDraft }),
    [submission],
  );
  const isVisibleThreadRunning = useCallback(() => threadStore.getActivity().isStreaming, [threadStore]);
  // Follow-ups typed during a run wait in the host's queue, not in the runtime.
  const currentActions = useCallback(() => actionsRef.current, []);
  const { queue, cancelQueued, steerQueued, reorderQueue, takeQueued } = useFollowUpQueue({
    client,
    threads: threadStore,
    sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
    isRunning: isVisibleThreadRunning,
    submit: submitPrompt,
    setNotice,
    actions: currentActions,
  });
  const returnQueued = useCallback((id?: string) => { void takeQueued(id).then((items) => returnToComposer(actionsRef.current, items)); }, [takeQueued]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const steerQueuedMessage = useCallback(() => {
    const head = queueRef.current[0];
    if (head) void steerQueued(head.id);
    return Boolean(head);
  }, [steerQueued]);
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
  const { abort: abortRun, duplicateThread, requireHost, settleActiveThread } = threadCommands;
  // Stop returns every queued message to the composer instead of sending it after the stop.
  const abortThread = useCallback((sessionId?: string) => { returnQueued(); abortRun(sessionId); }, [abortRun, returnQueued]);
  const {
    activateStage, pinStage, unpinStage, setStageView, cycleStageTab,
    applyHostResult, openWorkspace, createThreadInProject, switchSession, takeOverThread, openDraft, discardDraft,
  } = useThreadNavigation({
    ...(client ? { client } : {}),
    storage: clientStorage,
    view: viewStore,
    threads: threadStore,
    history: transcriptHistory,
    scopes: composerScopeStore,
    workbench: workbenchSession, drafts: workbenchSession.drafts,
    stage, setStage,
    requireHost,
    detachPendingDelivery: newThreadDelivery.detachPendingDelivery,
    newThread: newThreadPorts,
    activeDraftKey: currentDraftKey,
    composerRef,
    closeNewThreadPicker,
    inheritSelection,
    showThread,
  });
  const { threadTreeModal, closeThreadTree, openThreadTree, navigateThreadTree, forkFromTree, editFromMessage } = useThreadTree({
    ...(client ? { client } : {}),
    sessionId: currentSessionId,
    requireHost,
    applyActionResult,
    seedComposer: (text) => { if (actionsRef.current?.setComposerDraft) actionsRef.current.setComposerDraft(text); else setComposerSeed(text); },
    composerDraft: () => actionsRef.current?.composerDraft() ?? "",
    notify: (message) => setNotice(message),
    composerRef,
    requestFork: threadCommands.requestFork,
  });

  useEffect(() => {
    if (!client) return;
    if (workspaceCwd) void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
    // A project's own settings apply from the start screen on, before its thread has a workspace id.
    preferences.setWorkspace(activeWorkspaceId ?? workspaceCwd);
  }, [activeWorkspaceId, client, preferences, runtimeExtensions, workspaceCwd]);
  const syncDesktopExtensions = useCallback((only?: readonly string[], report?: PackagesChangeReport) => {
    void runtimeExtensions.resync(only, report).catch((error) => setNotice(errorMessage(error)));
  }, [runtimeExtensions, setNotice]);

  const windowShell = useWindowShell({
    client, threadStore, preferences, toasts: workbenchSession.toasts, setUpdateReady,
    openSettings: setSettingsPage, openExternal: (url) => platform.openExternal(url),
  });
  const hostEventTargets = useMemo<HostEventTargets>(() => ({
    client, registry, threadStore, view: viewStore, submission: newThreadDelivery, preferences,
    viewerHidden: () => document.hidden, currentDraftKey,
    transcriptTurnStart: turnScope.current,
    setTranscriptTurnStart: turnScope.set, applyHostUpdate, applyThreadIndex,
    syncDesktopExtensions, setUpdateReady, setNotice,
    // Electron titles the window after the page; a browser tab shows it too.
    setWindowTitle: (title) => { document.title = title; },
    windowShell: windowShell.handle,
  }), [
    client, currentDraftKey, preferences, registry, setNotice, setUpdateReady, windowShell.handle,
    newThreadDelivery, syncDesktopExtensions, threadStore, turnScope, viewStore,
  ]);
  const handleHostEvent = useCallback((event: HostEvent) => applyHostEvent(event, hostEventTargets), [hostEventTargets]);

  useEffect(() => {
    let unsubscribe = () => {};
    let stopBootstrap = () => {};
    let stopPrompts = () => {};
    if (client) {
      // A page showing another machine looks as the window's own machine does.
      const personPreferences = getPlatform()?.environments?.shownElsewhere ? client.personPreferences?.bind(client) : undefined;
      preferences.bindHost(client, activeWorkspaceId, personPreferences ? { get: () => personPreferences(), set: (patch) => personPreferences(patch) } : undefined);
      unsubscribe = client.onHostEvent(handleHostEvent);
      // A question raised while nobody was listening would otherwise stall the
      // host forever, including during bootstrap itself.
      stopPrompts = followOpenPrompts(client, viewStore);
      stopBootstrap = followWorkbenchBootstrap(client, workbenchSession, setNotice);
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return () => { unsubscribe(); stopBootstrap(); stopPrompts(); };
  }, [addEvent, applySnapshot, applyThreadIndex, client, handleHostEvent, threadStore, transcriptHistory, viewStore, workbenchSession]);

  const activeThreadIdForEvents = snapshot?.sessionId;
  useEffect(() => {
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: activeThreadIdForEvents });
  }, [activeThreadIdForEvents, registry]);

  useEffect(() => client?.onConnectionState((state) => registry.dispatchWorkbenchEvent({ type: "host-connection", state })), [client, registry]);

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

  // Desktop opens ready to type; touch opens without raising the keyboard.
  useEffect(() => {
    if (!snapshot?.sessionId || primaryPointerIsTouch()) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const idle = !active || active === document.body || active.tagName === "HTML";
      if (idle) composerRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [snapshot?.sessionId]);

  useWorkbenchToasts({
    view: viewStore, toasts: workbenchSession.toasts, update,
    openMachines: () => setSettingsPage("environments.machines"),
  });

  // Stage tab or drawer: where each panel shows, and the moves between them.
  const panelLayout = usePanelLayout({
    panels, stage, setStage, stageTabs, activePanel, setActivePanel, drawer, setDrawer,
    maximized, setStageMaximized,
    showStage: () => { setChatFocused(false); setStageFolded(false); },
    focusedPanel: () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-panel-id]")?.dataset.panelId,
    sheets: { open: (id) => workbenchControlRef.current?.openSheet(id) ?? false, close: (id) => workbenchControlRef.current?.closeSheet(id) ?? false },
    actions: () => actionsRef.current,
  });
  revealDocuments.current = panelLayout.documentOpened;
  const openPanel = panelLayout.openPanel;
  // One tab per file, however a link, the tree or a kit names it.
  const openFile = useCallback((path: string, options?: { pin?: boolean; view?: StageView; line?: number; trace?: boolean }) => {
    setStage((current) => openFileTab(current, projectFilePath(path, workspaceCwd), options));
    if (!options?.trace) revealDocuments.current();
  }, [workspaceCwd]);
  const { openWorkspaceFile, activeDocumentPath: stageFilePath } = useWorkspaceResourceNavigation({ stage, setStage, workspace: activeWorkspaceId, sourceId: registry.getDocumentSource()?.id, reveal: revealDocuments });
  const openThread = useCallback((sessionId: string, options?: { pin?: boolean; machine?: string }) => {
    const machine = lookInMachine(options?.machine, platform.environments);
    const lookIn = () => { setStage((current) => openThreadTab(current, sessionId, { ...(options?.pin ? { pin: true } : {}), ...(machine ? { machine } : {}) })); revealDocuments.current(); };
    if (!machine) { lookIn(); return; }
    void machineThreadPath(machine, sessionId, client, threadStore).then(async (path) => { if (path) await switchSession(path); else lookIn(); }).catch((error: unknown) => setNotice(errorMessage(error)));
  }, [client, platform, threadStore, switchSession, setNotice]);
  // A sub-agent's question waits on its parent too: that is where it is answered (design 1c).
  const parentOf = useCallback((sessionId: string) => threadStore.getSnapshot().threads.find((thread) => thread.id === sessionId)?.parentThreadId, [threadStore]);
  useEffect(() => {
    threadStore.setWaiting(uiPrompts.flatMap((entry) => [entry.sessionId, parentOf(entry.sessionId) ?? entry.sessionId]));
  }, [parentOf, threadStore, uiPrompts]);

  // A prompt must never be unanswerable. Workspace-level questions (project trust
  // is asked before any session exists) and questions naming a thread we do not
  // know surface on whatever thread is open, a child's on its parent's; only a
  // known other thread defers to its own rail badge.
  const threadPrompts = useMemo(() => {
    const known = new Set(threadStore.getSnapshot().threads.map((thread) => thread.id));
    return uiPrompts.filter((entry) => !entry.sessionId || entry.sessionId === snapshot?.sessionId
      || !known.has(entry.sessionId) || (snapshot && parentOf(entry.sessionId) === snapshot.sessionId));
  }, [parentOf, snapshot?.sessionId, threadStore, uiPrompts]);

  const copyMessage = useCallback((message: UiMessage) => threadCommands.copyText(
    message.role === "user" ? message.skill?.copyText ?? visibleUserMessageText(message.text) : message.text,
    "Message copied.",
  ), [threadCommands]);

  const { reloadWorkbench, reloadUi } = useWorkbenchReload({ client, requireHost, addEvent, setNotice });

  // A draft keeps its choice for the runtime it will run on, whatever thread is on screen.
  const draftRuntime = useCallback(() => effectiveNewThreadRuntime(newThreadController.current()?.runtime ?? preferences.getSnapshot().newThreadRuntime, viewStore.getSnapshot()), [newThreadController, preferences, viewStore]);
  const setComposerModel = useCallback(
    (provider: string, id: string) => newThreadController.setModel(
      provider, id, threadCommands.setModel,
      (p, mid) => viewStore.getSnapshot()?.models.find((m) => m.provider === p && m.id === mid)?.name,
      draftRuntime(),
    ),
    [draftRuntime, newThreadController, threadCommands, viewStore],
  );
  const setComposerThinking = useCallback(
    (level: string) => newThreadController.setThinking(level, threadCommands.setThinking, draftRuntime()),
    [draftRuntime, newThreadController, threadCommands],
  );
  // A draft keeps what it chose per runtime, so switching back and forth loses nothing.
  const selectDraftRuntime = useCallback((kind: string) => {
    newThreadController.switchRuntime(draftRuntime(), kind);
    preferences.setNewThreadRuntime(kind);
  }, [draftRuntime, newThreadController, preferences]);
  const setComposerMode = useCallback(async (mode: string) => {
    let accepted = true;
    await newThreadController.setMode(mode, async (next) => { accepted = await threadCommands.setMode(next); });
    return accepted;
  }, [newThreadController, threadCommands]);
  const submitText = useCallback((text: string) => submitPrompt(text), [submitPrompt]);
  const actions = useWorkbenchActions({
    hasPrivateThreadWorkspace: () => registry.getProjectSources().some((source) => source.createThreadWorkspace), client, platform, threadStore, viewStore, toasts: workbenchSession.toasts, composerScopeStore, threadCommands,
    snapshot, pendingNewThread, workspaceCwd, newThreadDeliveryPending, activeDraftKey,
    composerRef, transcriptRef, openPanel, closePanel: panelLayout.closePanel, togglePanelMaximized: panelLayout.toggleMaximized, openPalette, setSettingsPage, openNewThreadPicker, createThreadInProject,
    switchSession, openDraft, discardDraft, settleActiveThread, isVisibleThreadRunning, reloadWorkbench, openThreadTree,
    duplicateThread, setComposerSeed, setDockOpen: setStageShown, setNotice, openProjectSources,
    applyHostResult, stageTabs, cycleStageTab, openOverlay, closeOverlay,
    openWorkspace, openFile, openThread, setComposerHolds, setComposerModel, setComposerMode, submitPrompt: submitText, preferences,
    steerQueuedMessage, beforeAbort: returnQueued,
    openModelPicker, openInstructions, focusStage, showThread, toggleSidebar, toggleSpine, attachFiles, selectDraftRuntime, newThreadController, pages, threadView,
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
  // The workbench adds the tool runs to both contexts itself.
  const contextValue = useMemo(
    () => ({ snapshot: liveSnapshot, events, registry, activeDocumentPath: stageFilePath, openFile, openWorkspaceFile, applySnapshot, handleHostEvent }),
    [liveSnapshot, events, registry, stageFilePath, openFile, openWorkspaceFile, applySnapshot, handleHostEvent],
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
  // A draft chooses from the catalog of the runtime it is bound for; the thread on screen's levels are its model's.
  const boundRuntime = pendingNewThread && !pendingNewThread.sessionId ? effectiveNewThreadRuntime(pendingNewThread.runtime ?? settings.newThreadRuntime, snapshot) : undefined;
  const draftCatalog = useRuntimeCatalog(boundRuntime);
  const draftSnapshot = useMemo(() => pendingNewThread && snapshot && boundRuntime
    ? draftRuntimeSnapshot(snapshot, pendingNewThread, boundRuntime, draftCatalog)
    : snapshot, [draftCatalog, boundRuntime, pendingNewThread, snapshot]);
  const conversationSnapshot = useMemo(() => pendingNewThread && snapshot && draftSnapshot ? {
    ...draftSnapshot,
    cwd: pendingNewThread.projectPath,
    // A draft is a semantic scope, not a Pi session. The session ID remains
    // the last real runtime while the draft ID travels in TranscriptTurnStart.
    sessionName: undefined,
    sessionTitle: "Untitled thread",
    isStreaming: false,
    // The draft's choice shows on the catalog of the runtime it was made for; another runtime's overlay applied it already.
    ...(draftSnapshot === snapshot && pendingNewThread.model && (pendingNewThread.selectionRuntime ?? "pi") === (snapshot.backendKind ?? "pi") ? { model: pendingNewThread.model } : {}),
    ...(draftSnapshot === snapshot && pendingNewThread.thinkingLevel && (pendingNewThread.selectionRuntime ?? "pi") === (snapshot.backendKind ?? "pi") ? { thinkingLevel: pendingNewThread.thinkingLevel } : {}),
    mode: pendingNewThread.mode,
    modes: snapshot.runtimeBackends?.find((backend) => backend.kind === effectiveNewThreadRuntime(pendingNewThread.runtime ?? settings.newThreadRuntime, snapshot))?.modes,
    supportsImageInput: pendingNewThread.sessionId
      ? snapshot.sessionId === pendingNewThread.sessionId && snapshot.supportsImageInput === true
      : preparedThreadCapability?.cwd === pendingNewThread.projectPath
        ? preparedThreadCapability.supportsImageInput ?? false
        : false,
    taskProgress: undefined,
    taskHistory: [],
  } : snapshot ? { ...snapshot, isStreaming: visibleStreaming } : snapshot,
  [draftSnapshot, pendingNewThread, snapshot, visibleStreaming, preparedThreadCapability, settings.newThreadRuntime]);
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
    registry, threadStore, settings, layoutProfile, workspaceCwd, stageWorkspace, sidebarContributions, panels,
    openPanel, panelLayout, drawer, stageFolded, setStageFolded,
    chatFocused, setChatFocused, maximized, stageMaximized, setStageMaximized, stage, stageTabs, activateStageTab: activateStage,
    pinStageTab: pinStage, unpinStageTab: unpinStage, setStageFileView: setStageView, loadThread: threadCommands.loadThread, takeOverThread, documentState, documentSource, paletteOpen, paletteMenu, closePalette,
    commands, projectSourcesOpen, projectSource, closeProjectSources, newThreadPick, openNewThreadPicker,
    closeNewThreadPicker, projects, removeProject: threadCommands.removeProject, createThreadInProject, settingsPage, setSettingsPage,
    setNotice, activeOverlayId, closeOverlay, pages,
  }), [
    activeOverlayId, activateStage, chatFocused, stageMaximized, maximized, closeNewThreadPicker, layoutProfile,
    closeOverlay, closePalette, closeProjectSources, commands, createThreadInProject,
    documentSource, documentState, drawer, panelLayout, setStageFolded, stageFolded, newThreadPick,
    openNewThreadPicker, openPanel,
    threadCommands, paletteOpen, paletteMenu, panels, pinStage, projectSourcesOpen, projectSource, projects, registry,
    setNotice, setStageView, settings, settingsPage, stageTabs, unpinStage, pages,
    sidebarContributions, stage, stageWorkspace, takeOverThread, threadStore, workspaceCwd,
  ]);

  const thread = useMemo<WorkbenchThread>(() => ({
    snapshot: liveSnapshot, conversationSnapshot, pendingNewThread: Boolean(pendingNewThread), draftRuntime: pendingNewThread?.runtime,
    showStartScreen, startProjectPath, startProjectName, dropController: threadDropController,
    transcriptHistory, transcriptRef, loadTranscriptPage: threadCommands.loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptScope, transcriptTurnStart, visibleTranscriptTurnStart, lastMessageId: conversation.lastMessageId,
    recoverThread: threadCommands.recoverThread, copyToolOutput: threadCommands.copyToolOutput, loadToolOutput: threadCommands.loadToolOutput,
    runStartedAt, activeDraftKey, copyMessage, forkMessage: threadCommands.forkFromMessage, editMessage: editFromMessage,
    titleCommands, openThreadTree, duplicateThread, settleActiveThread, renameThread: threadCommands.renameThread, copyThreadValue: threadCommands.copyThreadValue,
    threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  }), [
    activeDraftKey, applyTranscriptPage, closeThreadTree, conversation.lastMessageId, conversationSnapshot,
    threadCommands, copyMessage, duplicateThread, editFromMessage, forkFromTree, liveSnapshot, navigateThreadTree,
    openThreadTree, pendingNewThread, runStartedAt, settleActiveThread, showStartScreen, startProjectName,
    startProjectPath, threadDropController, threadTreeModal, titleCommands,
    transcriptHistory, transcriptScope, transcriptScopeKey, transcriptTurnStart, visibleTranscriptTurnStart,
  ]);

  const composer = useMemo<WorkbenchComposer>(() => ({
    controlRef: composerControlRef,
    scopeStore: composerScopeStore, seed: composerSeed, textareaRef: composerRef,
    attachmentRef: composerAttachmentRef, queue, holds: composerHolds, prompts: conversationPrompts,
    submit: submitPrompt, abort: abortThread, cancelQueued, steerQueued, reorderQueue, returnQueued,
    setModel: setComposerModel, setThinking: setComposerThinking,
    selectRuntime: selectDraftRuntime, carryModel: newThreadController.carryToNextDraft,
    answerUiPrompt: threadCommands.answerUiPrompt, compactContext: threadCommands.compactContext,
  }), [
    abortThread, cancelQueued, threadCommands, composerHolds, composerScopeStore, composerSeed,
    conversationPrompts, queue, reorderQueue, returnQueued, setComposerModel, setComposerThinking, steerQueued, submitPrompt,
    selectDraftRuntime, newThreadController,
  ]);

  const workbenchModel = useMemo<WorkbenchModel>(() => ({
    view: viewStore, toasts: workbenchSession.toasts, actions, context: contextValue, shellContext: shellContextValue,
    observatoryContext: observatoryContextValue, layout, thread, composer,
  }), [actions, composer, contextValue, layout, observatoryContextValue, shellContextValue, thread, viewStore]);

  return <PlatformProvider platform={platform}>
    <Workbench model={workbenchModel} />
    {reloadUi}
    {windowShell.ui}
  </PlatformProvider>;
}
