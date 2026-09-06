import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionUiAnswer, HostEvent, HostSnapshot, ShellActionResult, ThreadIndexSnapshot, UiMessage, UiProject, UiToolRun, UiThreadTree } from "../shared/contracts";
import { namesWorkspace } from "../shared/workspace-identity";
import type { UiEditor, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { hostSnapshotFromThreadDetail, hostSnapshotWithCatalog, threadDetailFromHostSnapshot, type HostActionResult, type HostUpdate, type TranscriptPage } from "../shared/host-protocol";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import { mockSnapshot, mockThreadIndex, optimisticThreadSnapshot, reconcileOptimisticMessages, transcriptNavigationScope, transcriptNavigationScopeKey } from "./app-state";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { type ComposerAttachmentHandle } from "./components/Composer";
import { visibleUserMessageText } from "./components/MessageText";
import { type ThreadTreeMode } from "./components/ThreadTreeModal";
import { UpdateToast } from "./components/UpdateToast";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import { ComposerScopeStore, createDraftKey } from "./composer-scope-store";
import { useConversationActivities } from "./conversation-activities";
import { createNewThreadDraft, draftKey, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { errorMessage } from "./error-message";
import { ExtensionRegistry, hostExtensionBridge, type WorkbenchActions } from "./extension-system";
import { runtimeControls } from "./settings/runtime-controls";
import { FollowUpQueueStore } from "./follow-up-queue";
import { useHostClient } from "./host-client-context";
import { useClientStorage } from "./client-storage-context";
import { applyHostEvent, type HostEventTargets } from "./host-events";
import { usePreferences, useRendererServices } from "./renderer-services-context";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { activateTab as activateStageTab, activeTab as activeStageTab, closeTab as closeStageTab, EMPTY_STAGE, openFileTab, openThreadTab, pinTab as pinStageTab, setFileView, stageTabPath, type StageState, type StageView } from "./stage";
import { SubmissionController, type SubmissionControllerPorts } from "./submission-controller";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";
import { TranscriptHistoryController, type TranscriptBootstrapRequest, type TranscriptHistoryRequest, type TransitionToken } from "./transcript-history";
import { clearCachedTurnActivity, readCachedTurnActivity, writeCachedTurnActivity } from "./turn-activity";
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
  const safeMode = new URLSearchParams(window.location.search).get("safeMode") === "1";
  const cachedBootstrap = useMemo(() => readBootstrapCache(clientStorage), [clientStorage]);
  const [registry] = useState(() => {
    const value = new ExtensionRegistry(hostExtensionBridge(client), { preferences });
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
  const cachedSnapshotRef = useRef<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const cachedIndexRef = useRef<ThreadIndexSnapshot | undefined>(cachedBootstrap?.threadIndex);
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
  const [stage, setStage] = useState<StageState>(EMPTY_STAGE);
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
  const [dockOpen, setDockOpen] = useState(true);
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

  const applySnapshot = useCallback((next: HostSnapshot, request?: TranscriptBootstrapRequest): boolean => {
    if (request && !transcriptHistory.isCurrentBootstrap(request)) return false;
    // The bootstrap cache paints before the host answers; from here on the
    // session id on screen is one this host really has open.
    submission.notifyHostSnapshot();
    viewStore.beginThread(next.sessionId);
    const detail = threadDetailFromHostSnapshot(next);
    if (!transcriptHistory.syncSnapshot(next, detail, request)) return false;
    // applyHostSnapshot and setActiveThread both report the thread's run state
    // to the one writer, so nothing else has to repeat it.
    threadStore.applyHostSnapshot(next);
    if (next.model?.provider) threadStore.setThreadModelProvider(next.sessionId, next.model.provider);
    const cachedActivity = readCachedTurnActivity(clientStorage, next.sessionId);
    viewStore.setSnapshot(next);
    viewStore.setMessages(next.messages);
    const restoredActivity = next.turnActivity ?? cachedActivity;
    viewStore.setTools(restoredActivity?.tools ?? []);
    viewStore.setToolAnchorId(restoredActivity?.anchorMessageId);
    viewStore.setTurnActivity(next.turnActivityHistory ?? [], restoredActivity ? next.sessionId : undefined);
    cachedSnapshotRef.current = next;
    writeBootstrapCache(next, cachedIndexRef.current);
    return true;
  }, [submission, threadStore, transcriptHistory, viewStore]);

  const applyThreadIndex = useCallback((threadIndex: ThreadIndexSnapshot) => {
    threadStore.applyThreadIndex(threadIndex);
    transcriptHistory.setThreadIndex(threadIndex);
    cachedIndexRef.current = threadIndex;
    writeBootstrapCache(cachedSnapshotRef.current, threadIndex);
  }, [threadStore, transcriptHistory]);

  const applyTranscriptPage = useCallback((page: TranscriptPage, request?: TranscriptHistoryRequest) => {
    const application = transcriptHistory.applyPage(page, viewStore.getTranscript().messages, request);
    if (!application) return false;
    viewStore.setMessages(application.messages);
    const nextActivityHistory = application.snapshot?.turnActivityHistory ?? application.detail?.turnActivityHistory ?? [];
    viewStore.setTurnActivityHistory(nextActivityHistory);
    if (application.snapshot) viewStore.setSnapshot(application.snapshot);
    return true;
  }, [transcriptHistory, viewStore]);

  const applyHostUpdate = useCallback((update: HostUpdate): void => {
    if (update.version !== 1) return;
    if (update.type === "thread-index") {
      applyThreadIndex(update.index);
      return;
    }
    if (update.type === "thread-shell") {
      const shell = update.update.shell;
      threadStore.applyThreadShell(update.update.sessionId, shell, update.update.removed);
      if (shell) viewStore.setSnapshot((current) => current && current.sessionId === shell.id ? { ...current, sessionTitle: shell.title, projectLabel: shell.projectLabel } : current);
      return;
    }
    if (update.type === "thread-detail") {
      submission.notifyHostSnapshot();
      const detail = update.detail;
      const currentSnapshot = transcriptHistory.getCurrentSnapshot();
      const shell = threadStore.getThread(detail.sessionId);
      const prompt = detail.messages.find((message) => message.role === "user")?.text;
      const pending = currentPendingNewThread();
      const isCorrelatedCandidate = Boolean(shell) || detail.sessionId !== currentSnapshot?.sessionId;
      // A bridge-created session can arrive after the new-session call has
      // returned with no updates. Prepare the history coordinator for that
      // one explicitly correlated transition before applying its detail; an
      // unrelated late detail must remain subject to the normal race guard.
      if (pending && prompt !== undefined && isCorrelatedCandidate
        && detail.requestId !== undefined && detail.requestId === newThreadRequestRef.current) {
        transcriptHistory.prepareActionDetail(detail.sessionId);
      }
      const snapshotForDetail = currentSnapshot ? {
        ...currentSnapshot,
        sessionId: detail.sessionId,
        sessionTitle: shell?.title ?? currentSnapshot.sessionTitle,
        ...(currentSnapshot.sessionId === detail.sessionId ? {} : {
          supportsImageInput: false,
            }),
      } : undefined;
      const application = transcriptHistory.applyDetail(detail, snapshotForDetail);
      if (!application) return;
      const detailForRender = application.detail;
      const currentTurnStart = transcriptTurnStartRef.current;
      const pendingDraft = currentPendingNewThread();
      if (currentTurnStart?.scope?.kind === "draft"
        && pendingDraft
        && currentTurnStart.scope.draftId === pendingDraft.draftId) {
        const matchedPrompt = detailForRender.messages.find((message) => matchesTranscriptTurnMessage(message, currentTurnStart));
        if (matchedPrompt) {
          setTranscriptTurnStart({
            ...currentTurnStart,
            sessionId: detailForRender.sessionId,
            scope: { kind: "session", projectPath: pendingDraft.projectPath, sessionId: detailForRender.sessionId },
            messageId: matchedPrompt.id,
            scopeKey: transcriptNavigationScopeKey({ cwd: pendingDraft.projectPath, sessionId: detailForRender.sessionId }),
          }, currentTurnStart.turnId);
        }
      }
      viewStore.details.set(detailForRender);
      const reportedMessage = detailForRender.messages.find((message) => message.role === "user");
      const pendingForReport = currentPendingNewThread();
      if (isCorrelatedCandidate && reportedMessage && pendingForReport) {
        const promotedByReport = submission.promoteReportedThread(detail.sessionId, reportedMessage, detail.requestId)
          || promoteFromHostReport(detail.sessionId, shell?.projectPath ?? pendingForReport.projectPath, detail.requestId);
        if (promotedByReport) {
          composerScopeStore.moveScope(
            createDraftKey(draftKey(undefined, pendingForReport)),
            createDraftKey(draftKey(detail.sessionId)),
          );
        }
      }
      threadStore.setActiveThread(detail.sessionId, detail.isStreaming);
      if (detailForRender.sessionId !== viewStore.getState().activeThreadId) viewStore.beginThread(detailForRender.sessionId);
      viewStore.setMessages(detailForRender.messages);
      const cachedActivity = readCachedTurnActivity(clientStorage, detailForRender.sessionId);
      const restoredActivity = detailForRender.turnActivity ?? cachedActivity;
      viewStore.setTools(restoredActivity?.tools ?? []);
      viewStore.setToolAnchorId(restoredActivity?.anchorMessageId);
      viewStore.setTurnActivity(detailForRender.turnActivityHistory ?? [], restoredActivity ? detailForRender.sessionId : undefined);
      viewStore.setSnapshot((current) => {
        const next = application.snapshot ?? current;
        if (!next) return current;
        const enriched = {
          ...next,
          ...(detail.backendKind ? { backendKind: detail.backendKind } : {}),
          ...(detail.threadId ? { threadId: detail.threadId } : {}),
          ...(detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : {}),
          turnActivityHistory: detailForRender.turnActivityHistory,
        };
        cachedSnapshotRef.current = enriched;
        writeBootstrapCache(enriched, cachedIndexRef.current);
        return enriched;
      });
      return;
    }
    if (update.type === "transcript-page") {
      const page = update.page;
      applyTranscriptPage(page);
      return;
    }
    if (update.type === "catalog") {
      if (update.catalog.model?.provider) threadStore.setThreadModelProvider(threadStore.getSnapshot().activeThreadId, update.catalog.model.provider);
      // The history cache is the base a later thread detail merges onto, so it
      // has to take the catalog too; otherwise the next detail restores the
      // model the thread had before this change.
      transcriptHistory.applyCatalog(update.catalog);
      viewStore.setSnapshot((current) => {
        if (!current || (update.catalog.sessionId !== undefined && current.sessionId !== update.catalog.sessionId)) return current;
        const next = hostSnapshotWithCatalog(current, update.catalog);
        cachedSnapshotRef.current = next;
        writeBootstrapCache(next, cachedIndexRef.current);
        return next;
      });
      return;
    }
    if (update.type === "project") {
      viewStore.setSnapshot((current) => current ? { ...current, ...update.project } : current);
      return;
    }
    if (update.type === "run") threadStore.setThreadRunning(update.sessionId, update.event === "started");
    if (update.type === "error") setNotice(update.message);
  }, [applyThreadIndex, applyTranscriptPage, composerScopeStore, currentPendingNewThread, promoteFromHostReport, setTranscriptTurnStart, submission, threadStore, transcriptHistory, viewStore]);

  const applyActionResult = useCallback((result: import("../shared/host-protocol").HostActionResult, expectedTransition?: TransitionToken): boolean => {
    if (expectedTransition !== undefined && !transcriptHistory.isCurrentThreadTransition(expectedTransition)) return false;
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (detail?.type === "thread-detail") {
      const prepared = expectedTransition === undefined
        ? transcriptHistory.prepareActionDetail(detail.detail.sessionId)
        : transcriptHistory.confirmThreadTransition(expectedTransition, detail.detail.sessionId);
      if (!prepared) return false;
    }
    result.updates.forEach((update) => applyHostUpdate(update));
    return true;
  }, [applyHostUpdate, transcriptHistory]);

  // A prepared thread is not a runtime session yet, so its project is the
  // only trustworthy workspace identity while it is on screen. In
  // particular, do not expose the last real thread's worktree in the chrome.
  const workspaceCwd = safeMode ? undefined : (pendingNewThread?.projectPath ?? snapshot?.cwd);
  useEffect(() => {
    if (!workspaceCwd || !client) return;
    void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
  }, [client, runtimeExtensions, workspaceCwd]);
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
      unsubscribe = client.onHostEvent(handleHostEvent);
      // A question raised while nobody was listening would otherwise stall the
      // host forever, including during bootstrap itself.
      void client.syncExtensionUi().catch(() => undefined);
      const bootstrapRequest = transcriptHistory.beginBootstrap();
      client.bootstrap().then((bootstrap) => {
        if (!transcriptHistory.isCurrentBootstrap(bootstrapRequest)) return;
        applyThreadIndex(bootstrap.threadIndex);
        const current = hostSnapshotFromThreadDetail({
          cwd: bootstrap.project.cwd,
          projectLabel: bootstrap.project.label,
          sessionId: bootstrap.detail.sessionId,
          sessionTitle: bootstrap.threadIndex.sessions.find((thread) => thread.id === bootstrap.detail.sessionId)?.title ?? "Untitled thread",
          backendKind: bootstrap.detail.backendKind ?? bootstrap.catalog.backendKind,
          models: bootstrap.catalog.models,
          model: bootstrap.catalog.model,
          runtimeCapabilities: bootstrap.catalog.runtimeCapabilities,
          thinkingLevel: bootstrap.catalog.thinkingLevel,
          thinkingLevels: bootstrap.catalog.thinkingLevels,
          allTools: bootstrap.catalog.allTools,
          composerCommands: bootstrap.catalog.composerCommands ?? [],
          extensionCount: bootstrap.catalog.extensionCount,
          supportsImageInput: bootstrap.catalog.supportsImageInput ?? false,
          messages: [],
          isStreaming: false,
          activeTools: [],
        }, bootstrap.detail);
        if (!applySnapshot(current, bootstrapRequest)) return;
      }).catch((error) => {
        if (transcriptHistory.isCurrentBootstrap(bootstrapRequest)) setNotice(errorMessage(error));
      });
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, client, handleHostEvent, transcriptHistory]);

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

  const loadTranscriptPage = useCallback(async (sessionId: string, cursor: HostTranscriptCursor) => {
    if (!client) throw new Error("Transcript history requires the Electron host.");
    return client.loadTranscript(sessionId, cursor);
  }, [client]);


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
  const closeNewThreadPicker = useCallback(() => setNewThreadOpen(false), []);
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
  const loadThread = useCallback(async (sessionId: string) => {
    if (!client) throw new Error("Reading another thread requires the Electron host");
    return (await client.loadTranscript(sessionId)).messages;
  }, [client]);
  /**
   * Applies a host action result. A project change clears the stage. Most
   * thread changes keep unsent composer text; explicit project switches do not.
   */
  const applyHostResult = useCallback((result: HostActionResult, inheritDraft = true) => {
    const cwd = result.updates.find((update) => update.type === "project")?.project.cwd;
    const previousCwd = viewStore.getSnapshot()?.cwd;
    const pendingDraft = inheritDraft ? composerRef.current?.value ?? "" : "";
    applyActionResult(result);
    if (cwd && cwd !== previousCwd) setStage(EMPTY_STAGE);
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (pendingDraft && detail?.type === "thread-detail") {
      composerScopeStore.setDraft(createDraftKey(draftKey(detail.detail.sessionId)), pendingDraft);
    }
  }, [applyActionResult, composerScopeStore, viewStore]);

  const requireHost = useCallback((what: string): boolean => {
    if (client) return true;
    setNotice(`${what} requires the Electron host`);
    return false;
  }, [client]);

  // Shared by the composer and the activity rail's stop button, so neither
  // recreates it every render and defeats a downstream memo.
  const abortThread = useCallback((sessionId?: string) => { void client?.abort(sessionId); }, [client]);

  const discardPendingNewThread = useCallback((expected?: NewThreadDraft): boolean => {
    const current = currentPendingNewThread();
    if (!current || (expected && current.draftId !== expected.draftId)) return false;
    invalidateNewThread();
    setPendingNewThread(undefined);
    writeNewThreadDraft(clientStorage);
    return true;
  }, [invalidateNewThread, setPendingNewThread]);

  const openWorkspace = useCallback(async (workspace: string, options?: { inheritDraft?: boolean }): Promise<boolean> => {
    const pending = currentPendingNewThread();
    if (namesWorkspace(workspace, pending?.workspaceId ?? snapshot?.workspaceId, pending?.projectPath ?? snapshot?.cwd)) return true;
    if (!requireHost("Project switching")) return false;
    submission.detachPendingDelivery();
    // A draft for another project sits above the still-active host thread. If
    // the user picks that host project again, revealing it is the whole switch.
    if (pending && namesWorkspace(workspace, snapshot?.workspaceId, snapshot?.cwd)) {
      discardPendingNewThread(pending);
      setStage(EMPTY_STAGE);
      return true;
    }
    try {
      const result = await client!.openProject(workspace);
      if (pending) discardPendingNewThread(pending);
      applyHostResult(result, options?.inheritDraft ?? false);
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyHostResult, discardPendingNewThread, requireHost, snapshot?.cwd, snapshot?.workspaceId, submission]);

  const removeProject = useCallback(async (project: UiProject) => {
    if (!requireHost("Project removal")) return;
    try {
      applyActionResult(await client!.removeProject(project.workspaceId ?? project.path));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const createThreadInProject = useCallback((project: UiProject) => {
    const activeScope = pendingNewThread && activeDraftKey ? composerScopeStore.getSnapshot(activeDraftKey) : undefined;
    // A submitted draft keeps delivering in the background. Its text is on its
    // way to the runtime, so there is nothing to carry into the fresh draft.
    const inFlight = submission.detachPendingDelivery() || Boolean(activeScope?.submissionPending);
    const nextDraft = createNewThreadDraft({ projectPath: project.path, workspaceId: project.workspaceId, projectName: project.name });
    const destinationScope = draftKey(undefined, nextDraft);
    const sourceSnapshot = inFlight ? undefined : activeScope;
    // Only another unsubmitted draft may carry editor state into this new
    // scope. A real thread's scope can still own a pending submission; moving
    // it would make the fresh draft inherit that lifecycle and stay disabled.
    if (sourceSnapshot && activeDraftKey && destinationScope) {
      composerScopeStore.transferDraft(activeDraftKey, destinationScope);
    }
    // A new project is a new draft scope, but changing projects before the
    // first send should not discard what the user already composed. Attachments
    // stay memory-only and move with the scope; text also survives a reload.
    const draft = sourceSnapshot?.draft ? { ...nextDraft, draft: sourceSnapshot.draft } : nextDraft;
    beginNewThread(draft);
    setNewThreadOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeDraftKey, beginNewThread, composerScopeStore, pendingNewThread, submission]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    const target = threadStore.getSnapshot().threads.find((session) => session.path === path);
    submission.detachPendingDelivery();
    invalidateNewThread();
    setPendingNewThread(undefined);
    writeNewThreadDraft(clientStorage);
    const startedAt = performance.now();
    const previous = snapshot;
    const cached = target ? transcriptHistory.getDetail(target.id) : undefined;
    if (cached && snapshot && target) {
      applySnapshot(optimisticThreadSnapshot(snapshot, target, cached));
      addEvent("thread.switch.cached", target?.title);
    }
    const transition = transcriptHistory.beginThreadSwitch(target?.id);
    try {
      const next = await client!.switchSession(path);
      if (!applyActionResult(next, transition)) return false;
      threadStore.markRead(target?.id ?? "");
      addEvent("thread.switch.confirmed", `${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } catch (error) {
      if (!transcriptHistory.isCurrentThreadTransition(transition)) return false;
      if (previous) applySnapshot(previous);
      setNotice(errorMessage(error));
      return false;
    }
  }, [addEvent, applyActionResult, applySnapshot, invalidateNewThread, requireHost, snapshot, submission, threadStore]);

  /** The one way out of a read-only thread tab: make it the thread on screen. */
  const takeOverThread = useCallback((sessionId: string) => {
    const path = threadStore.getThread(sessionId)?.path;
    if (path) void switchSession(path);
  }, [switchSession, threadStore]);

  const renameThread = useCallback(async (title: string): Promise<boolean> => {
    if (!requireHost("Thread rename")) return false;
    try {
      applyActionResult(await client!.renameThread(
        title,
        threadStore.getSnapshot().activeThreadId,
      ));
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyActionResult, requireHost, threadStore]);

  const setModel = useCallback(async (provider: string, id: string) => {
    if (!requireHost("Model selection")) return;
    try {
      applyActionResult(await client!.setModel(provider, id));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const setThinking = useCallback(async (level: string) => {
    if (!requireHost("Thinking level")) return;
    try {
      applyActionResult(await client!.setThinkingLevel(level));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const recoverThread = useCallback(async () => {
    if (!requireHost("Thread recovery")) return;
    try {
      const sessionId = snapshot?.sessionId;
      applyActionResult(await client!.recoverThread());
      // The stalled row is restored from a renderer-side cache, so clearing the
      // session alone would leave the ghost on screen.
      if (sessionId) clearCachedTurnActivity(clientStorage, sessionId);
      viewStore.setTools([]);
      viewStore.setToolAnchorId(undefined);
      setNotice("Closed the interrupted call. The thread can continue.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId, viewStore]);

  const compactContext = useCallback(async () => {
    if (!requireHost("Compaction")) return;
    try {
      applyActionResult(await client!.compactContext());
      setNotice("Context compacted.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  /** Pi's `!command` for extensions: runs in the active thread's project. */
  const runShellAction = useCallback(async (command: string, includeInContext: boolean): Promise<ShellActionResult> => {
    if (!client) throw new Error("Project actions require the Electron host");
    return client.runShellAction(command, includeInContext, snapshot?.cwd);
  }, [client, snapshot?.cwd]);

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

  const answerUiPrompt = useCallback((id: string, answer: ExtensionUiAnswer) => {
    const prompt = viewStore.getUiPrompts().find((entry) => entry.id === id);
    if (prompt) registry.notifyPromptAnswered(prompt, answer);
    viewStore.setUiPrompts((current) => current.filter((entry) => entry.id !== id));
    void client?.answerExtensionUi(id, answer);
  }, [client, registry]);

  const settleActiveThread = useCallback(() => {
    const activeId = threadStore.getSnapshot().activeThreadId;
    if (!activeId) return;
    preferences.toggleSettled(activeId);
  }, [threadStore]);

  const copyThreadValue = useCallback(async (kind: "chat" | "path" | "thread-id") => {
    if (kind === "chat") {
      if (!snapshot?.sessionId || !client) return;
      try {
        await client.copyThreadMarkdown(snapshot.sessionId);
        setNotice("Chat copied as Markdown.");
      } catch (error) {
        setNotice(errorMessage(error));
      }
      return;
    }
    const value = kind === "path" ? snapshot?.cwd : snapshot?.sessionId;
    if (!value) {
      setNotice("Value is unavailable.");
      return;
    }
    try {
      await client?.copyText(value);
      setNotice(`${kind === "path" ? "Path" : "Thread ID"} copied.`);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [client, snapshot?.cwd, snapshot?.sessionId]);

  const copyMessage = useCallback(async (message: UiMessage) => {
    try {
      const copyText = message.role === "user"
        ? message.skill?.copyText ?? visibleUserMessageText(message.text)
        : message.text;
      await client?.copyText(copyText);
      setNotice("Message copied.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [client]);

  const copyToolOutput = useCallback(async (tool: UiToolRun) => {
    if (!snapshot?.sessionId || !client) {
      setNotice("Tool output is unavailable.");
      return;
    }
    try {
      const result = await client.readToolOutput(snapshot.sessionId, tool.id);
      if (!result) throw new Error("The complete tool output is no longer available.");
      await client.copyText(result.output);
      setNotice(result.truncated
        ? "Tool output exceeded the read limit; the bounded result was copied."
        : "Full tool output copied.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [snapshot?.sessionId]);

  const forkMessage = useCallback(async (message: UiMessage) => {
    if (!message.sourceEntryId || !snapshot?.sessionId || !requireHost("Fork thread")) return;
    try {
      setNotice("Forking thread…");
      applyActionResult(await client!.forkThread(message.sourceEntryId, snapshot.sessionId));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  // Pi's /tree, /fork and /clone for the thread on screen.
  const [threadTreeModal, setThreadTreeModal] = useState<{ mode: ThreadTreeMode; tree?: UiThreadTree; error?: string; busy: boolean }>();
  const closeThreadTree = useCallback(() => setThreadTreeModal(undefined), []);
  const openThreadTree = useCallback((mode: ThreadTreeMode = "navigate") => {
    if (!requireHost("Thread tree")) return;
    setThreadTreeModal({ mode, busy: false });
    client!.threadTree(snapshot?.sessionId)
      .then((tree) => setThreadTreeModal((current) => current && { ...current, tree }))
      .catch((error) => setThreadTreeModal((current) => current && { ...current, error: errorMessage(error) }));
  }, [requireHost, snapshot?.sessionId]);
  const navigateThreadTree = useCallback(async (entryId: string, summarize: boolean) => {
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      const result = await client!.navigateThreadTree(entryId, { summarize }, snapshot?.sessionId);
      if (result.cancelled) {
        setThreadTreeModal((current) => current && { ...current, busy: false });
        return;
      }
      applyActionResult(result);
      setThreadTreeModal(undefined);
      if (result.draftText) setComposerSeed(result.draftText);
      composerRef.current?.focus();
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, snapshot?.sessionId]);
  const forkFromTree = useCallback(async (entryId: string) => {
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      applyActionResult(await client!.forkThread(entryId, snapshot?.sessionId));
      setThreadTreeModal(undefined);
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, snapshot?.sessionId]);
  const duplicateThread = useCallback(async () => {
    if (!requireHost("Duplicate thread")) return false;
    try {
      setNotice("Duplicating thread…");
      applyActionResult(await client!.duplicateThread(snapshot?.sessionId));
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

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
    notify: setNotice,
    openProjectSources: () => { setNewThreadOpen(false); setProjectSourcesOpen(true); },
    applyHostResult,
    copyText: async (text: string) => { await client?.copyText(text); },
    openOverlay: (id) => setActiveOverlayId(id),
    closeOverlay: () => setActiveOverlayId(undefined),
    openWorkspace,
    activeThread: () => ({
      sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
      cwd: workspaceCwd,
      workspaceId: pendingNewThread?.workspaceId ?? snapshot?.workspaceId,
      model: snapshot?.model,
      draftPending: newThreadDeliveryPending,
    }),
    openFile,
    openThread,
    runShellAction,
    holdComposer: () => { setComposerHolds((count) => count + 1); return () => setComposerHolds((count) => Math.max(0, count - 1)); },
    composerDraft: () => activeDraftKey ? composerScopeStore.getSnapshot(activeDraftKey).draft : "",
  }), [
    applyHostResult, client, openPanel, openThread,
    activeDraftKey, openWorkspace, reloadWorkbench, settleActiveThread, snapshot, switchSession,
    openThreadTree, duplicateThread,
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
    viewStore, recoverThread, copyToolOutput, abortSessionId: snapshot?.sessionId,
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
    registry, threadStore, settings, workspaceCwd, sidebarContributions, panels, activePanel,
    openedPanels, openPanel, dockOpen, setDockOpen, centerRef, centerCompact, setCenterCompact,
    chatFocused, setChatFocused, stage, activateStageTab: activateStage, closeStageTab: closeStage,
    pinStageTab: pinStage, setStageFileView: setStageView, loadThread, takeOverThread, documentState, documentSource, visibleStreaming, paletteOpen, closePalette,
    commands, projectSourcesOpen, closeProjectSources, newThreadOpen, openNewThreadPicker,
    closeNewThreadPicker, projects, removeProject, createThreadInProject, settingsPage, setSettingsPage,
    notice: notice?.message, noticeLevel: notice?.level ?? "info", setNotice, activeOverlayId, closeOverlay,
  }), [
    activePanel, activeOverlayId, activateStage, centerCompact, chatFocused, closeNewThreadPicker,
    closeOverlay, closePalette, closeProjectSources, closeStage, commands, createThreadInProject,
    documentSource, documentState, dockOpen, newThreadOpen, notice, openNewThreadPicker, openPanel,
    loadThread, openedPanels, paletteOpen, panels, pinStage, projectSourcesOpen, projects, registry,
    removeProject, setNotice, setStageView, settings, settingsPage,
    sidebarContributions, stage, takeOverThread, threadStore, visibleStreaming, workspaceCwd,
  ]);

  const thread = useMemo<WorkbenchThread>(() => ({
    snapshot: liveSnapshot, conversationSnapshot, pendingNewThread: Boolean(pendingNewThread),
    showStartScreen, startProjectPath, startProjectName, dropController: threadDropController,
    transcriptHistory, transcriptRef, loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptScope, transcriptTurnStart, visibleTranscriptTurnStart, transcriptActivities,
    liveStatusLabel, conversationActivityTools, runStartedAt, activeDraftKey, copyMessage, forkMessage,
    titleCommands, openThreadTree, duplicateThread, settleActiveThread, renameThread, copyThreadValue,
    threadTreeModal, closeThreadTree, navigateThreadTree, forkFromTree,
  }), [
    activeDraftKey, applyTranscriptPage, closeThreadTree, conversationActivityTools,
    conversationSnapshot, copyMessage, copyThreadValue, duplicateThread, forkFromTree, forkMessage,
    liveSnapshot, liveStatusLabel, loadTranscriptPage, navigateThreadTree, openThreadTree,
    pendingNewThread, renameThread, runStartedAt, settleActiveThread, showStartScreen,
    startProjectName, startProjectPath, threadDropController, threadTreeModal, titleCommands,
    transcriptActivities, transcriptHistory, transcriptScope, transcriptScopeKey, transcriptTurnStart,
    visibleTranscriptTurnStart,
  ]);

  const composer = useMemo<WorkbenchComposer>(() => ({
    scopeStore: composerScopeStore, seed: composerSeed, textareaRef: composerRef,
    attachmentRef: composerAttachmentRef, queue, holds: composerHolds, prompts: conversationPrompts,
    submit: submitPrompt, abort: abortThread,
    cancelQueued, steerQueued, reorderQueue, setModel, setThinking, answerUiPrompt, compactContext,
  }), [
    abortThread, answerUiPrompt, cancelQueued, compactContext, composerHolds, composerScopeStore, composerSeed,
    conversationPrompts, queue, reorderQueue, setModel, setThinking, steerQueued, submitPrompt,
  ]);

  const workbenchModel = useMemo<WorkbenchModel>(() => ({
    view: viewStore, actions, context: contextValue, shellContext: shellContextValue,
    observatoryContext: observatoryContextValue, layout, thread, composer,
  }), [actions, composer, contextValue, layout, observatoryContextValue, shellContextValue, thread, viewStore]);

  return <>
    <Workbench model={workbenchModel} />
    {updateReady ? <UpdateToast
      version={updateReady}
      onRestart={() => { void client?.installUpdate(); }}
      onDismiss={() => setUpdateReady(undefined)}
    /> : null}
    {reloadUi}
  </>;
}
