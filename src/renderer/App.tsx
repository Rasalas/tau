import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { ChevronDown, Folder, PanelRight, PanelRightClose } from "lucide-react";
import type {
  ClientTurnIdentity,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  HostEvent,
  HostSnapshot,
  NewThreadRequestId,
  PreparedPrompt,
  ShellActionResult,
  ThreadIndexSnapshot,
  UiMessage,
  UiProject,
  UiPromptAttachment,
  UiSession,
  UiSkillDraft,
  UiToolRun,
  UiThreadTree,
} from "../shared/contracts";
import type { DiffLoadOptions, FileNode, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges, WorkspaceInfo } from "../shared/workspace-kit-types";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { ChangedFiles } from "./components/ChangedFiles";
import { changesSinceTurn, changesTouchedByTools, clearCachedTurnActivity, readCachedTurnActivity, writeCachedTurnActivity } from "./turn-activity";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { Composer, type ComposerAttachmentHandle, type SubmitResult } from "./components/Composer";
import { allocateAttachmentId, ComposerScopeStore, createDraftKey, type ComposerScopeReference, type DraftKey, type PendingAttachment } from "./composer-scope-store";
import { errorMessage } from "./error-message";
import type { ContextBreakdown } from "./components/ContextMeter";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
import {
  activateTab as activateStageTab, activeTab as activeStageTab, closeTab as closeStageTab, EMPTY_STAGE,
  openFileTab, pinTab as pinStageTab, setFileView, type StageState, type StageView,
} from "./stage";
const EMPTY_COMPOSER_ATTACHMENTS = { attachments: [] as const };

import { TitleBar } from "./components/TitleBar";
import { PanelIcon } from "./components/PanelIcon";
import { ToolGroup } from "./components/ToolGroup";
import { TranscriptViewport } from "./components/TranscriptViewport";
import type { TranscriptTurnStart } from "./components/transcript-navigation";
import type { TranscriptActivity } from "./components/transcript-activity";
import { TaskProgress } from "./components/TaskProgress";
import { ProjectPicker } from "./components/ProjectPicker";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";
import { bundledExtensions } from "./extensions";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { preferences } from "./preferences";
import { ProjectSourcesModal } from "./components/ProjectSources";
import { ThreadTreeModal, type ThreadTreeMode } from "./components/ThreadTreeModal";
import { Region, StatusLine } from "./components/Regions";
import { ReloadCurtain, type ReloadPhase } from "./components/ReloadCurtain";
import { ReloadConflictDialog } from "./components/ReloadConflictDialog";

const noopSubscribe = () => () => {};
const EMPTY_DOCUMENTS: { changes: UiWorkspaceChanges; editor?: UiEditor } = { changes: { files: [], added: 0, removed: 0 } };
const emptyDocumentState = () => EMPTY_DOCUMENTS;
const loadFileUnavailable = async (path: string): Promise<UiFileContent> => ({ path, name: path.split("/").at(-1) ?? path, size: 0, kind: "text", text: "File contents require a document source." });
const loadDiffUnavailable = async (path: string): Promise<UiFileDiff> => ({ path, added: 0, removed: 0, hunks: [], note: "Diffs require a document source." });
import { createNewThreadDraft, draftKey, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { useFollowUpQueue, type SubmitPrompt } from "./use-follow-up-queue";
import { ThreadStore } from "./thread-store";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { displayPath } from "./path-display";
import { hostSnapshotFromThreadDetail, threadDetailFromHostSnapshot, type HostActionResult, type HostUpdate, type ThreadDetail, type TranscriptPage } from "../shared/host-protocol";
import { visibleUserMessageText } from "./components/MessageText";
import { THREAD_DROP_FEEDBACK } from "../shared/thread-drop";
import { usePreparedThreadCapability } from "./use-prepared-thread-capability";
import { useThreadDropController } from "./use-thread-drop-controller";
import { useNewThreadController } from "./use-new-thread-controller";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { estimateTranscriptTokens, TranscriptMessageIndex, type TranscriptMessageUpdate } from "../shared/transcript-index";
import { matchesTranscriptTurnMessage } from "../shared/transcript-turn";
import {
  ThreadStoreContext,
  WorkbenchContext,
  WorkbenchShellContext,
  ObservatoryContext,
  type TimelineEvent,
} from "./workbench-context";
import { TranscriptHistoryBoundary } from "./components/TranscriptHistoryBoundary";

import {
  TranscriptHistoryController,
  type TranscriptBootstrapRequest,
  type TranscriptHistoryRequest,
  type TransitionToken,
} from "./transcript-history";
import {
  backgroundNewThreadDetail,
  createClientMessageId,
  estimateTokens,
  isCurrentTranscriptSubmission,
  isSameUserMessage,
  latestActivityAnchor,
  mergeNewThreadRecoveryAttachments,
  mergeNewThreadRecoveryDraft,
  mergeTranscriptMessages,
  mockSnapshot,
  mockThreadIndex,
  optimisticThreadSnapshot,
  reconcileOptimisticMessages,
  skillPresentationForDraft,
  transcriptNavigationScope,
  transcriptNavigationScopeKey,
  type NewThreadSubmissionCompletion,
  type NewThreadSubmissionRecovery,
  type OptimisticUserMessage,
  type TranscriptSubmissionIdentity,
} from "./app-state";
import { ComposerHost, LiveStatus, useTailScroll } from "./components/ComposerHost";
import { applyHostEvent, type HostEventStores } from "./host-events";
import { Workbench } from "./Workbench";
import { useConversationActivities } from "./conversation-activities";

export {
  isCurrentTranscriptSubmission,
  latestActivityAnchor,
  mergeNewThreadRecoveryAttachments,
  mergeNewThreadRecoveryDraft,
  optimisticThreadSnapshot,
  reconcileOptimisticMessages,
  skillPresentationForDraft,
  transcriptNavigationScopeKey,
} from "./app-state";
export { ComposerHost, measureComposerGeometry, useTailScroll } from "./components/ComposerHost";
export { MountedPanel } from "./Workbench";

const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

export default function App() {
  const safeMode = new URLSearchParams(window.location.search).get("safeMode") === "1";
  const cachedBootstrap = useMemo(() => readBootstrapCache(), []);
  const [registry] = useState(() => {
    const value = new ExtensionRegistry();
    bundledExtensions.forEach((extension) => {
      value.addKnown(extension);
      if (!safeMode && preferences.isExtensionEnabled(extension.id)) value.activate(extension);
    });
    return value;
  });
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion);
  // Extensions from ~/.tau/extensions and <project>/.tau/extensions load at
  // runtime, like Pi's own; the project set follows the open workspace.
  const noticeRef = useRef<(message: string) => void>(() => {});
  const eventRef = useRef<(label: string, detail?: string) => void>(() => {});
  const [runtimeExtensions] = useState(() => {
    installSharedModules();
    return new RuntimeExtensions(registry, {
      load: (cwd, sharedExports) => window.tau?.loadDesktopExtensions
        ? window.tau.loadDesktopExtensions(cwd, sharedExports)
        : Promise.resolve({ bundles: [], errors: [], skipped: [] }),
      isEnabled: (id) => preferences.isExtensionEnabled(id),
      notify: (message) => noticeRef.current(message),
      log: (label, detail) => eventRef.current(label, detail),
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
  ));
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const threadActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);

  const [snapshot, setSnapshot] = useState<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const snapshotRef = useRef<HostSnapshot | undefined>(snapshot);
  snapshotRef.current = snapshot;
  const cachedSnapshotRef = useRef<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const cachedIndexRef = useRef<ThreadIndexSnapshot | undefined>(cachedBootstrap?.threadIndex);
  // Run state lives in the thread store, fed by the host's per-thread status
  // events. Deriving it here keeps the composer, the live row and the rail from
  // ever disagreeing about whether the visible thread is working.
  const visibleStreaming = Boolean(snapshot && threadActivity.runningThreadIds.includes(snapshot.sessionId));
  const visibleStreamingRef = useRef(false);
  visibleStreamingRef.current = visibleStreaming;
  const transcriptMessageIndexRef = useRef<TranscriptMessageIndex | undefined>(undefined);
  if (!transcriptMessageIndexRef.current) {
    transcriptMessageIndexRef.current = new TranscriptMessageIndex(cachedBootstrap?.snapshot.messages ?? []);
  }
  const [messages, setMessages] = useState<UiMessage[]>(() => transcriptMessageIndexRef.current!.messages);
  const [transcriptRevision, setTranscriptRevision] = useState(() => transcriptMessageIndexRef.current!.revision);
  const transcriptUserRevision = transcriptMessageIndexRef.current.userRevision;
  const transcriptTokenEstimate = transcriptMessageIndexRef.current.tokenEstimate;
  const transcriptLookupRevision = transcriptMessageIndexRef.current.lookupRevision;
  const replaceTranscriptMessages = useCallback((next: readonly UiMessage[]) => {
    setMessages(transcriptMessageIndexRef.current!.replace(next));
    setTranscriptRevision(transcriptMessageIndexRef.current!.revision);
  }, []);
  const updateTranscriptMessages = useCallback((updates: ReadonlyMap<string, TranscriptMessageUpdate>) => {
    setMessages(transcriptMessageIndexRef.current!.updateMany(updates));
    setTranscriptRevision(transcriptMessageIndexRef.current!.revision);
  }, []);
  const appendTranscriptMessage = useCallback((message: UiMessage) => {
    setMessages(transcriptMessageIndexRef.current!.append(message));
    setTranscriptRevision(transcriptMessageIndexRef.current!.revision);
  }, []);
  const prependTranscriptMessages = useCallback((next: readonly UiMessage[]) => {
    setMessages(transcriptMessageIndexRef.current!.prepend(next));
    setTranscriptRevision(transcriptMessageIndexRef.current!.revision);
  }, []);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);
  const [tools, setTools] = useState<UiToolRun[]>([]);
  const [turnActivityHistory, setTurnActivityHistory] = useState(cachedBootstrap?.snapshot.turnActivityHistory ?? []);
  const [toolAnchorId, setToolAnchorId] = useState<string>();
  const [turnActivitySessionId, setTurnActivitySessionId] = useState<string>();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [uiPrompts, setUiPrompts] = useState<ExtensionUiPrompt[]>([]);
  const uiPromptsRef = useRef(uiPrompts);
  uiPromptsRef.current = uiPrompts;
  const [runStartedAt, setRunStartedAt] = useState<number>();
  // Legacy sessions may only have the old renderer cache. A settled run with
  // nothing durable behind it must not leave that stale cache looking current.
  const [activePanel, setActivePanel] = useState("");
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [projectSourcesOpen, setProjectSourcesOpen] = useState(false);
  const [activeOverlayId, setActiveOverlayId] = useState<string>();
  const newThreadController = useNewThreadController(window.localStorage);
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
  } = newThreadController;
  const pendingNewThreadRef = useRef(pendingNewThread);
  pendingNewThreadRef.current = pendingNewThread;
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
  const newThreadRecoveryRef = useRef(new Map<string, NewThreadSubmissionRecovery>());
  // Promotion applies host details and host details can promote. The recovery
  // side of that pair is reached through this ref so neither has to be declared
  // inside the other's initializer.
  const promoteRecoveryRef = useRef<(clientMessageId: string, sessionId: string, message?: UiMessage) => boolean>(() => false);
  const [, setNewThreadRecoveryVersion] = useState(0);
  const newThreadDeliveryPending = Boolean(pendingNewThread);
  const [notice, setNoticeText] = useState<string>();
  const [noticeLevel, setNoticeLevel] = useState<"info" | "warning" | "error">("info");
  const [reloadPhase, setReloadPhase] = useState<ReloadPhase>();
  const [reloadConflictCount, setReloadConflictCount] = useState<number>();
  const setNotice = useCallback((message?: string, level: "info" | "warning" | "error" = "info") => {
    setNoticeLevel(level);
    setNoticeText(message);
  }, []);
  // Follow-ups typed during a run wait in the workbench, not in the runtime.
  const submitRef = useRef<SubmitPrompt>(async () => ({ accepted: false, message: "The composer is not ready yet." }));
  const { queue, enqueue: enqueueFollowUp, cancelQueued, steerQueued, reorderQueue } = useFollowUpQueue({
    sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
    streamingRef: visibleStreamingRef,
    runningThreadIds: threadActivity.runningThreadIds,
    submitRef,
    setNotice,
  });
  const [dockOpen, setDockOpen] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachmentRef = useRef<ComposerAttachmentHandle>(null);
  const actionsRef = useRef<WorkbenchActions | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptTurnSequenceRef = useRef(0);
  const transcriptTurnStartRef = useRef<TranscriptTurnStart | undefined>(undefined);
  const detailStoreRef = useRef(new ThreadDetailStore(5));
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const toolAnchorRef = useRef<string | undefined>(undefined);
  toolAnchorRef.current = toolAnchorId;
  const assistantStartsRef = useRef(new Map<string, number>());
  /** Empty live assistant rows wait here until an extension row asks for their entry. */
  const pendingAssistantAnchorsRef = useRef(new Map<string, { id: string; timestamp: number; beforeMessageId?: string }>());
  const pendingDeltasRef = useRef(new Map<string, { text: string; thinking: string }>());
  const deltaFrameRef = useRef<number | undefined>(undefined);
  const pendingToolUpdatesRef = useRef(new Map<string, string>());
  const toolFrameRef = useRef<number | undefined>(undefined);
  const runningThreadRef = useRef<string>("");
  const activeDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
  const activeDraftKeyRef = useRef(activeDraftKey);
  activeDraftKeyRef.current = activeDraftKey;
  const restoreNewThreadSubmission = useCallback((recovery: NewThreadSubmissionRecovery) => {
    const scope = recovery.scopeRef.scope;
    const current = composerScopeStore.getSnapshot(scope);
    const draft = mergeNewThreadRecoveryDraft(recovery.draft, current.draft);
    const attachments = mergeNewThreadRecoveryAttachments(recovery.attachments, current.attachments);
    // Keep edits made while the runtime was starting and place the failed
    // prompt before them, so neither text nor a newly selected image vanishes.
    if (draft !== current.draft) {
      composerScopeStore.setDraft(scope, draft);
      writeComposerDraft(window.localStorage, scope, draft);
    }
    if (attachments.length !== current.attachments.length) {
      composerScopeStore.setAttachments(scope, attachments);
    }
    // Draft scopes are persisted through the active-new-thread record. A late
    // detached failure can otherwise restore the textarea only until reload.
    if (typeof scope === "string" && scope.startsWith("new:")) {
      const pending = pendingNewThreadRef.current;
      if (pending && draftKey(undefined, pending) === scope) {
        writeNewThreadDraft(window.localStorage, { ...pending, draft: draft || undefined });
      }
    }
  }, [composerScopeStore]);
  const releaseNewThreadRecovery = useCallback((clientMessageId: string) => {
    const recovery = newThreadRecoveryRef.current.get(clientMessageId);
    if (!recovery) return;
    newThreadRecoveryRef.current.delete(clientMessageId);
    composerScopeStore.releaseScopeReference(recovery.scopeRef);
    setNewThreadRecoveryVersion((version) => version + 1);
  }, [composerScopeStore]);
  const settleNewThreadRecoveryIpc = useCallback((clientMessageId: string, recovery?: NewThreadSubmissionRecovery) => {
    const current = recovery ?? newThreadRecoveryRef.current.get(clientMessageId);
    if (!current) return;
    current.ipcPending = false;
  }, []);
  const transcriptScopeKey = transcriptNavigationScopeKey(snapshot, pendingNewThread);
  const transcriptScope = useMemo(
    () => transcriptNavigationScope(snapshot, pendingNewThread),
    [pendingNewThread, snapshot?.cwd, snapshot?.sessionId],
  );
  const transcriptScopeKeyRef = useRef(transcriptScopeKey);
  const committedTranscriptScopeKeyRef = useRef(transcriptScopeKey);
  transcriptScopeKeyRef.current = transcriptScopeKey;
  const setTranscriptTurnStart = useCallback((
    next: TranscriptTurnStart | undefined,
    expectedTurnId?: string,
  ): boolean => {
    if (expectedTurnId !== undefined && transcriptTurnStartRef.current?.turnId !== expectedTurnId) return false;
    const scoped = next ? { ...next, scopeKey: next.scopeKey ?? transcriptScopeKeyRef.current } : undefined;
    transcriptTurnStartRef.current = scoped;
    setTranscriptTurnStartState(scoped);
    return true;
  }, []);
  useEffect(() => {
    const previous = committedTranscriptScopeKeyRef.current;
    if (previous === transcriptScopeKey) return;
    committedTranscriptScopeKeyRef.current = transcriptScopeKey;
    transcriptScopeKeyRef.current = transcriptScopeKey;
    const currentTurnStart = transcriptTurnStartRef.current;
    if (currentTurnStart?.scopeKey === transcriptScopeKey && currentTurnStart.preserveAcrossSessionChange) return;
    setTranscriptTurnStart(undefined);
  }, [setTranscriptTurnStart, transcriptScopeKey]);
  const visibleTranscriptTurnStart = transcriptTurnStart?.scopeKey === transcriptScopeKey
    ? transcriptTurnStart
    : undefined;
  const updateTools = useCallback((update: UiToolRun[] | ((current: UiToolRun[]) => UiToolRun[])) => {
    const next = typeof update === "function" ? update(toolsRef.current) : update;
    toolsRef.current = next;
    setTools(next);
  }, []);
  useEffect(() => {
    const reconciled = reconcileOptimisticMessages(optimisticMessages, messages);
    if (reconciled.length === optimisticMessages.length) return;
    if (pendingNewThread && reconciled.every((entry) => entry.scope !== activeDraftKey)) {
      writeNewThreadDraft(window.localStorage);
      setPendingNewThread(undefined);
    }
    setOptimisticMessages(reconciled);
  }, [activeDraftKey, optimisticMessages, pendingNewThread, transcriptUserRevision]);

  const flushAssistantDeltas = useCallback(() => {
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    const pending = pendingDeltasRef.current;
    if (pending.size === 0) return;
    pendingDeltasRef.current = new Map();
    const updates = new Map<string, TranscriptMessageUpdate>();
    for (const [id, delta] of pending) {
      updates.set(id, (message) => ({
        ...message,
        text: message.text + delta.text,
        thinking: delta.thinking ? (message.thinking ?? "") + delta.thinking : message.thinking,
      }));
    }
    updateTranscriptMessages(updates);
  }, [updateTranscriptMessages]);

  const queueAssistantDelta = useCallback((id: string, kind: "text" | "thinking", delta: string) => {
    const current = pendingDeltasRef.current.get(id) ?? { text: "", thinking: "" };
    current[kind] += delta;
    pendingDeltasRef.current.set(id, current);
    if (deltaFrameRef.current === undefined) {
      deltaFrameRef.current = requestAnimationFrame(flushAssistantDeltas);
    }
  }, [flushAssistantDeltas]);

  const flushToolUpdates = useCallback(() => {
    toolFrameRef.current = undefined;
    const pending = pendingToolUpdatesRef.current;
    if (pending.size === 0) return;
    pendingToolUpdatesRef.current = new Map();
    updateTools((current) => current.map((tool) => {
      const output = pending.get(tool.id);
      return output === undefined || output === tool.output ? tool : { ...tool, output };
    }));
  }, [updateTools]);

  const queueToolUpdate = useCallback((id: string, output: string) => {
    pendingToolUpdatesRef.current.set(id, output);
    if (toolFrameRef.current === undefined) toolFrameRef.current = requestAnimationFrame(flushToolUpdates);
  }, [flushToolUpdates]);

  const applySnapshot = useCallback((next: HostSnapshot, request?: TranscriptBootstrapRequest): boolean => {
    if (request && !transcriptHistory.isCurrentBootstrap(request)) return false;
    assistantStartsRef.current.clear();
    pendingAssistantAnchorsRef.current.clear();
    pendingDeltasRef.current.clear();
    pendingToolUpdatesRef.current.clear();
    if (toolFrameRef.current !== undefined) cancelAnimationFrame(toolFrameRef.current);
    toolFrameRef.current = undefined;
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    const detail = threadDetailFromHostSnapshot(next);
    if (!transcriptHistory.syncSnapshot(next, detail, request)) return false;
    threadStore.applyHostSnapshot(next);
    threadStore.setThreadRunning(next.sessionId, next.isStreaming);
    const cachedActivity = readCachedTurnActivity(window.localStorage, next.sessionId);
    setSnapshot(next);
    replaceTranscriptMessages(next.messages);
    const restoredActivity = next.turnActivity ?? cachedActivity;
    updateTools(restoredActivity?.tools ?? []);
    toolAnchorRef.current = restoredActivity?.anchorMessageId;
    setToolAnchorId(restoredActivity?.anchorMessageId);
    setTurnActivityHistory(next.turnActivityHistory ?? []);
    setTurnActivitySessionId(restoredActivity ? next.sessionId : undefined);
    cachedSnapshotRef.current = next;
    writeBootstrapCache(next, cachedIndexRef.current);
    return true;
  }, [replaceTranscriptMessages, threadStore, transcriptHistory, updateTools]);

  const applyThreadIndex = useCallback((threadIndex: ThreadIndexSnapshot) => {
    threadStore.applyThreadIndex(threadIndex);
    transcriptHistory.setThreadIndex(threadIndex);
    cachedIndexRef.current = threadIndex;
    writeBootstrapCache(cachedSnapshotRef.current, threadIndex);
  }, [threadStore, transcriptHistory]);

  const applyTranscriptPage = useCallback((page: TranscriptPage, request?: TranscriptHistoryRequest) => {
    const application = transcriptHistory.applyPage(page, messagesRef.current, request);
    if (!application) return false;
    setMessages(application.messages);
    const nextActivityHistory = application.snapshot?.turnActivityHistory ?? application.detail?.turnActivityHistory ?? [];
    setTurnActivityHistory(nextActivityHistory);
    if (application.snapshot) setSnapshot(application.snapshot);
    return true;
  }, [transcriptHistory]);

  const applyHostUpdate = useCallback((update: HostUpdate) => {
    if (update.version !== 1) return;
    if (update.type === "thread-index") {
      applyThreadIndex(update.index);
      return;
    }
    if (update.type === "thread-shell") {
      const shell = update.update.shell;
      threadStore.applyThreadShell(update.update.sessionId, shell, update.update.removed);
      if (shell) setSnapshot((current) => current && current.sessionId === shell.id ? { ...current, sessionTitle: shell.title, projectLabel: shell.projectLabel } : current);
      return;
    }
    if (update.type === "thread-detail") {
      const detail = update.detail;
      const currentSnapshot = transcriptHistory.getCurrentSnapshot();
      const shell = threadStore.getThread(detail.sessionId);
      const prompt = detail.messages.find((message) => message.role === "user")?.text;
      const pending = pendingNewThreadRef.current;
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
      const pendingDraft = pendingNewThreadRef.current;
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
      detailStoreRef.current.set(detailForRender);
      const reportedMessage = detailForRender.messages.find((message) => message.role === "user");
      if (isCorrelatedCandidate && reportedMessage && pendingNewThreadRef.current) {
        const pending = pendingNewThreadRef.current;
        // Either identity correlates this report to a detached delivery: the
        // persisted client message, or the new-thread request it belongs to.
        const recoveryEntry = detail.requestId
          ? [...newThreadRecoveryRef.current.entries()].find(([, recovery]) => recovery.requestId === detail.requestId)
          : undefined;
        const reportedClientMessageId = reportedMessage.clientMessageId;
        const recoveryClientMessageId = reportedClientMessageId !== undefined
          && newThreadRecoveryRef.current.has(reportedClientMessageId)
          ? reportedClientMessageId
          : recoveryEntry?.[0];
        const promotedRecovery = recoveryClientMessageId
          ? promoteRecoveryRef.current(recoveryClientMessageId, detail.sessionId, reportedMessage)
          : false;
        const promotedByReport = promotedRecovery || promoteFromHostReport(
          detail.sessionId,
          shell?.projectPath ?? pending.projectPath,
          detail.requestId,
        );
        if (promotedByReport) {
          composerScopeStore.moveScope(
            createDraftKey(draftKey(undefined, pending)),
            createDraftKey(draftKey(detail.sessionId)),
          );
        }
      }
      threadStore.setActiveThread(detail.sessionId, detail.isStreaming);
      threadStore.setThreadRunning(detail.sessionId, detail.isStreaming);
      replaceTranscriptMessages(detailForRender.messages);
      const cachedActivity = readCachedTurnActivity(window.localStorage, detailForRender.sessionId);
      const restoredActivity = detailForRender.turnActivity ?? cachedActivity;
      updateTools(restoredActivity?.tools ?? []);
      toolAnchorRef.current = restoredActivity?.anchorMessageId;
      setToolAnchorId(restoredActivity?.anchorMessageId);
      const nextActivityHistory = detailForRender.turnActivityHistory ?? [];
      setTurnActivityHistory(nextActivityHistory);
      setTurnActivitySessionId(restoredActivity ? detailForRender.sessionId : undefined);
      setSnapshot((current) => {
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
      setSnapshot((current) => {
        if (!current || (update.catalog.sessionId !== undefined && current.sessionId !== update.catalog.sessionId)) return current;
        const { sessionId: _sessionId, supportsImageInput, ...legacyCatalog } = update.catalog;
          return {
            ...current,
            ...legacyCatalog,
            ...(update.catalog.sessionId === undefined
              ? {}
              : { supportsImageInput: supportsImageInput ?? false }),
          };
      });
      return;
    }
    if (update.type === "project") {
      setSnapshot((current) => current ? { ...current, ...update.project } : current);
      return;
    }
    if (update.type === "run" && update.sessionId === threadStore.getSnapshot().activeThreadId) {
      threadStore.setStreaming(update.event === "started");
    }
    if (update.type === "error") setNotice(update.message);
  }, [applyThreadIndex, applyTranscriptPage, composerScopeStore, promoteFromHostReport, replaceTranscriptMessages, setTranscriptTurnStart, threadStore, transcriptHistory, updateTools]);

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

  const notifyNewThreadPromptSubmitted = useCallback((
    pending: NewThreadDraft,
    sessionId: string,
    prompt: string,
    recovery?: NewThreadSubmissionRecovery,
  ) => {
    if (recovery?.notified) return;
    const currentActions = actionsRef.current;
    if (!currentActions) return;
    if (recovery) recovery.notified = true;
    const currentSnapshot = snapshotRef.current;
    void registry.notifyPromptSubmitted({
      prompt,
      snapshot: currentSnapshot ? {
        ...currentSnapshot,
        cwd: pending.projectPath,
        sessionId,
        sessionName: undefined,
        sessionTitle: "Untitled thread",
        messages: [],
        isStreaming: false,
        activeTools: [],
        turnActivity: undefined,
        taskProgress: undefined,
        taskHistory: [],
      } : undefined,
    }, currentActions).catch((error) => setNotice(errorMessage(error)));
  }, [registry]);

  /** Commit a new-thread delivery without changing whichever thread is now visible. */
  const promoteRecoveryToSession = useCallback((
    clientMessageId: string,
    sessionId: string,
    message?: UiMessage,
  ): boolean => {
    const recovery = newThreadRecoveryRef.current.get(clientMessageId);
    if (!recovery || recovery.failed) return false;
    if (recovery.sessionId && recovery.sessionId !== sessionId) return false;
    const keepInBackground = recovery.detached && threadStore.getSnapshot().activeThreadId !== sessionId;
    // A detached delivery must not reclaim the visible new-thread controller.
    const promotedScope = recovery.detached ? undefined : promoteFromUserMessage(sessionId, recovery.pending.projectPath);
    if (!promotedScope && recovery.sessionId !== sessionId) return false;
    recovery.sessionId = sessionId;
    recovery.promoted = true;
    composerScopeStore.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(sessionId)));
    setOptimisticMessages((current) => message
      ? current.map((entry) => entry.message.clientMessageId === clientMessageId
        ? { ...entry, scope: `session:${sessionId}` }
        : entry)
      : current.filter((entry) => entry.message.clientMessageId !== clientMessageId));

    const turnStart = transcriptTurnStartRef.current;
    if (turnStart?.clientMessageId === clientMessageId) {
      setTranscriptTurnStart(message ? {
        ...turnStart,
        sessionId,
        scope: { kind: "session", projectPath: recovery.pending.projectPath, sessionId },
        scopeKey: transcriptNavigationScopeKey({ cwd: recovery.pending.projectPath, sessionId }),
      } : undefined, turnStart.turnId);
    }

    if (keepInBackground) {
      if (message) {
        detailStoreRef.current.set(backgroundNewThreadDetail(detailStoreRef.current.get(sessionId), sessionId, message));
        threadStore.setThreadRunning(sessionId, true);
      } else {
        threadStore.setThreadRunning(sessionId, false);
      }
    } else if (!message) {
      // An extension command answered the prompt without a user turn and
      // without an agent run. The thread exists; nothing is in flight in it.
      threadStore.setActiveThread(sessionId, false);
    } else if (!detailStoreRef.current.get(sessionId)?.messages.some((entry) => isSameUserMessage(entry, message))) {
      // A blank detail may have arrived before this event. Feed the confirmed
      // message through the normal detail path so the history coordinator and
      // the active snapshot move together even when no catalog is available.
      transcriptHistory.prepareActionDetail(sessionId);
      applyHostUpdate({
        version: 1,
        type: "thread-detail",
        detail: {
          sessionId,
          messages: [message],
          isStreaming: true,
          activeTools: [],
        },
      });
    } else {
      threadStore.setActiveThread(sessionId, true);
    }
    notifyNewThreadPromptSubmitted(recovery.pending, sessionId, message?.text || recovery.draft, recovery);
    // Delivery acceptance is the commit point. The later IPC acknowledgement
    // must not keep thread navigation blocked and is safe because this record
    // is already promoted before the result can arrive.
    releaseNewThreadRecovery(clientMessageId);
    return true;
  }, [applyHostUpdate, composerScopeStore, notifyNewThreadPromptSubmitted, promoteFromUserMessage, releaseNewThreadRecovery, setTranscriptTurnStart, threadStore, transcriptHistory]);
  promoteRecoveryRef.current = promoteRecoveryToSession;

  const restoreFailedNewThreadRecovery = useCallback((recovery: NewThreadSubmissionRecovery, sessionId: string) => {
    recovery.sessionId = sessionId || recovery.sessionId;
    const oldScope = recovery.scopeRef.scope;
    const visible = activeDraftKeyRef.current === oldScope
      || (recovery.sessionId !== undefined && threadStore.getSnapshot().activeThreadId === recovery.sessionId);
    let pending = pendingNewThreadRef.current;

    // Once a positive user-message promoted the draft, a later failure must
    // reopen that same runtime-backed draft. Retrying it then uses sendPrompt
    // with the generated session id instead of allocating another runtime.
    if (visible && recovery.promoted
      && (!pending || pending.draftId !== recovery.pending.draftId)) {
      pending = { ...recovery.pending, ...(recovery.sessionId ? { sessionId: recovery.sessionId } : {}) };
      const target = createDraftKey(draftKey(undefined, pending));
      composerScopeStore.moveScope(oldScope, target);
      recovery.scopeRef.scope = target;
      pendingNewThreadRef.current = pending;
      setPendingNewThread(pending);
      writeNewThreadDraft(window.localStorage, pending);
    } else if (visible && pending && pending.draftId === recovery.pending.draftId && recovery.sessionId && !pending.sessionId) {
      pending = { ...pending, sessionId: recovery.sessionId };
      pendingNewThreadRef.current = pending;
      setPendingNewThread(pending);
      writeNewThreadDraft(window.localStorage, pending);
    }
    restoreNewThreadSubmission(recovery);
  }, [composerScopeStore, restoreNewThreadSubmission, setPendingNewThread, threadStore]);

  const settleNewThreadDelivery = useCallback((
    clientMessageId: string,
    sessionId: string,
    settlement: { accepted: true } | { accepted: false; message: string },
  ): boolean => {
    const recovery = newThreadRecoveryRef.current.get(clientMessageId);
    if (!recovery) return false;
    if (settlement.accepted) {
      const promoted = promoteRecoveryToSession(
        clientMessageId,
        sessionId,
        recovery.withoutUserTurn ? undefined : recovery.optimistic,
      );
      // The host has committed this delivery. Whether the draft was still there
      // to promote decides nothing: holding the record would block thread
      // switching and every guarded workspace action for the rest of the session.
      if (!promoted) releaseNewThreadRecovery(clientMessageId);
      return true;
    }
    recovery.failed = settlement.message || "The runtime rejected the message.";
    restoreFailedNewThreadRecovery(recovery, sessionId);
    // A failed delivery is safe to release once its IPC acknowledgement has
    // arrived; until then the late accepted result must not clear recovery.
    if (!recovery.ipcPending) releaseNewThreadRecovery(clientMessageId);
    return true;
  }, [promoteRecoveryToSession, releaseNewThreadRecovery, restoreFailedNewThreadRecovery]);

  const addEvent = useCallback((label: string, detail?: string, timestamp = Date.now()) => {
    setEvents((current) => [...current.slice(-99), { id: `${timestamp}-${Math.random()}`, label, detail, timestamp }]);
  }, []);
  noticeRef.current = setNotice;
  eventRef.current = addEvent;

  // A prepared thread is not a runtime session yet, so its project is the
  // only trustworthy workspace identity while it is on screen. In
  // particular, do not expose the last real thread's worktree in the chrome.
  const workspaceCwd = safeMode ? undefined : (pendingNewThread?.projectPath ?? snapshot?.cwd);
  useEffect(() => {
    if (!workspaceCwd || !window.tau) return;
    void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
  }, [runtimeExtensions, workspaceCwd]);

  const hostEventStores = useMemo<HostEventStores>(() => ({
    registry,
    threadStore,
    detailStore: detailStoreRef.current,
    messages: messagesRef,
    transcriptTurnStart: transcriptTurnStartRef,
    recoveries: newThreadRecoveryRef,
    activeDraftKey: activeDraftKeyRef,
    assistantStarts: assistantStartsRef,
    pendingToolUpdates: pendingToolUpdatesRef,
    toolFrame: toolFrameRef,
    toolAnchor: toolAnchorRef,
    runningThread: runningThreadRef,
    assistantAnchors: pendingAssistantAnchorsRef,
    transcriptIndex: transcriptMessageIndexRef as { current: TranscriptMessageIndex },
    setOptimisticMessages,
    setTranscriptTurnStart,
    setNotice,
    settleNewThreadDelivery,
    promoteRecoveryToSession,
    applyHostUpdate,
    applyThreadIndex,
    flushAssistantDeltas,
    flushToolUpdates,
    updateTools,
    setToolAnchorId,
    setTurnActivitySessionId,
    setSnapshot,
    setRunStartedAt,
    appendTranscriptMessage,
    queueAssistantDelta,
    replaceTranscriptMessages,
    updateTranscriptMessages,
    setMessages,
    queueToolUpdate,
    addEvent,
    setUiPrompts,
  }), [addEvent, appendTranscriptMessage, applyHostUpdate, applyThreadIndex, flushAssistantDeltas, flushToolUpdates, promoteRecoveryToSession, queueAssistantDelta, queueToolUpdate, registry, replaceTranscriptMessages, setTranscriptTurnStart, settleNewThreadDelivery, threadStore, updateTranscriptMessages, updateTools]);
  const handleHostEvent = useCallback((event: HostEvent) => applyHostEvent(event, hostEventStores), [hostEventStores]);

  useEffect(() => {
    let unsubscribe = () => {};
    if (window.tau) {
      unsubscribe = window.tau.onHostEvent(handleHostEvent);
      // A question raised while nobody was listening would otherwise stall the
      // host forever, including during bootstrap itself.
      void window.tau.syncExtensionUi?.().catch(() => undefined);
      const bootstrapRequest = transcriptHistory.beginBootstrap();
      window.tau.bootstrap().then((bootstrap) => {
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
  }, [addEvent, applySnapshot, applyThreadIndex, handleHostEvent, transcriptHistory]);

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
    if (!window.tau) throw new Error("Transcript history requires the Electron host.");
    return window.tau.loadTranscript(sessionId, cursor);
  }, []);

  useTailScroll(transcriptRef, [messages, tools], snapshot?.sessionId, transcriptHistory.preserveScrollRef);

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
  const openFile = useCallback((path: string, options?: { pin?: boolean; view?: StageView }) => {
    setStage((current) => openFileTab(current, path, options));
    setChatFocused(false);
  }, []);
  /**
   * Applies a host action result. A project change clears the stage. Most
   * thread changes keep unsent composer text; explicit project switches do not.
   */
  const applyHostResult = useCallback((result: HostActionResult, inheritDraft = true) => {
    const cwd = result.updates.find((update) => update.type === "project")?.project.cwd;
    const pendingDraft = inheritDraft ? composerRef.current?.value ?? "" : "";
    applyActionResult(result);
    if (cwd && cwd !== snapshot?.cwd) setStage(EMPTY_STAGE);
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (pendingDraft && detail?.type === "thread-detail") {
      composerScopeStore.setDraft(createDraftKey(draftKey(detail.detail.sessionId)), pendingDraft);
    }
  }, [applyActionResult, composerScopeStore, snapshot?.cwd]);

  const requireHost = useCallback((what: string): boolean => {
    if (window.tau) return true;
    setNotice(`${what} requires the Electron host`);
    return false;
  }, []);

  // Once the first message is being delivered, its draft scope must stay alive
  // until it has a session to detach to. An unsubmitted draft has no such host
  // lifecycle and can be discarded immediately.
  const allowProjectSwitch = useCallback((): boolean => {
    if (![...newThreadRecoveryRef.current.values()].some((recovery) => !recovery.detached)) return true;
    setNotice("Wait for the current message delivery to finish before changing projects.");
    return false;
  }, []);

  const discardPendingNewThread = useCallback((expected?: NewThreadDraft): boolean => {
    const current = pendingNewThreadRef.current;
    if (!current || (expected && current.draftId !== expected.draftId)) return false;
    invalidateNewThread();
    pendingNewThreadRef.current = undefined;
    setPendingNewThread(undefined);
    writeNewThreadDraft(window.localStorage);
    return true;
  }, [invalidateNewThread, setPendingNewThread]);

  const openWorkspace = useCallback(async (path: string, options?: { inheritDraft?: boolean }): Promise<boolean> => {
    const pending = pendingNewThreadRef.current;
    if (path === (pending?.projectPath ?? snapshot?.cwd)) return true;
    if (!allowProjectSwitch() || !requireHost("Project switching")) return false;
    // A draft for another project sits above the still-active host thread. If
    // the user picks that host project again, revealing it is the whole switch.
    if (pending && path === snapshot?.cwd) {
      discardPendingNewThread(pending);
      setStage(EMPTY_STAGE);
      return true;
    }
    try {
      const result = await window.tau!.openProject(path);
      if (pending) discardPendingNewThread(pending);
      applyHostResult(result, options?.inheritDraft ?? false);
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [allowProjectSwitch, applyHostResult, discardPendingNewThread, requireHost, snapshot?.cwd]);

  const removeProject = useCallback(async (project: UiProject) => {
    if (!requireHost("Project removal")) return;
    try {
      applyActionResult(await window.tau!.removeProject(project.path));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const createThreadInProject = useCallback((project: UiProject) => {
    if ([...newThreadRecoveryRef.current.values()].some((recovery) => !recovery.detached)) {
      setNotice("Wait for the current message delivery to finish before changing projects.");
      return;
    }
    if (pendingNewThread && activeDraftKey && composerScopeStore.getSnapshot(activeDraftKey).submissionPending) {
      setNotice("Wait for the current message to be accepted before changing projects.");
      return;
    }
    const nextDraft = createNewThreadDraft({ projectPath: project.path, projectName: project.name });
    const destinationScope = draftKey(undefined, nextDraft);
    const sourceSnapshot = pendingNewThread && activeDraftKey
      ? composerScopeStore.getSnapshot(activeDraftKey)
      : undefined;
    // Only another unsubmitted draft may carry editor state into this new
    // scope. A real thread's scope can still own a pending submission; moving
    // it would make the fresh draft inherit that lifecycle and stay disabled.
    if (pendingNewThread && activeDraftKey && destinationScope) {
      composerScopeStore.transferDraft(activeDraftKey, destinationScope);
    }
    // A new project is a new draft scope, but changing projects before the
    // first send should not discard what the user already composed. Attachments
    // stay memory-only and move with the scope; text also survives a reload.
    const draft = sourceSnapshot?.draft ? { ...nextDraft, draft: sourceSnapshot.draft } : nextDraft;
    beginNewThread(draft);
    setNewThreadOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeDraftKey, beginNewThread, composerScopeStore, pendingNewThread]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    const target = threadStore.getSnapshot().threads.find((session) => session.path === path);
    const currentRecoveryEntry = pendingNewThreadRef.current
      ? [...newThreadRecoveryRef.current.entries()].find(([, recovery]) => recovery.pending.draftId === pendingNewThreadRef.current?.draftId) : undefined;
    if (currentRecoveryEntry) {
      const [, recovery] = currentRecoveryEntry;
      if (recovery.ipcPending || !recovery.sessionId) {
        setNotice("Wait for the new thread to start before changing threads.");
        return false;
      }
      recovery.detached = true;
      composerScopeStore.moveScope(recovery.scopeRef.scope, createDraftKey(draftKey(recovery.sessionId)));
      setOptimisticMessages((current) => current.map((entry) => entry.message.clientMessageId === currentRecoveryEntry[0]
        ? { ...entry, scope: `session:${recovery.sessionId}` } : entry));
    }
    invalidateNewThread();
    setPendingNewThread(undefined);
    writeNewThreadDraft(window.localStorage);
    const startedAt = performance.now();
    const previous = snapshot;
    const cached = target ? transcriptHistory.getDetail(target.id) : undefined;
    if (cached && snapshot && target) {
      applySnapshot(optimisticThreadSnapshot(snapshot, target, cached));
      addEvent("thread.switch.cached", target?.title);
    }
    const transition = transcriptHistory.beginThreadSwitch(target?.id);
    try {
      const next = await window.tau!.switchSession(path);
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
  }, [addEvent, applyActionResult, applySnapshot, composerScopeStore, invalidateNewThread, requireHost, snapshot, threadStore]);

  const renameThread = useCallback(async (title: string): Promise<boolean> => {
    if (!requireHost("Thread rename")) return false;
    try {
      applyActionResult(await window.tau!.renameThread(
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
      applyActionResult(await window.tau!.setModel(provider, id));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const setThinking = useCallback(async (level: string) => {
    if (!requireHost("Thinking level")) return;
    try {
      applyActionResult(await window.tau!.setThinkingLevel(level));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const recoverThread = useCallback(async () => {
    if (!requireHost("Thread recovery")) return;
    try {
      const sessionId = snapshot?.sessionId;
      applyActionResult(await window.tau!.recoverThread());
      // The stalled row is restored from a renderer-side cache, so clearing the
      // session alone would leave the ghost on screen.
      if (sessionId) clearCachedTurnActivity(window.localStorage, sessionId);
      updateTools([]);
      toolAnchorRef.current = undefined;
      setToolAnchorId(undefined);
      setNotice("Closed the interrupted call. The thread can continue.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId, updateTools]);

  const compactContext = useCallback(async () => {
    if (!requireHost("Compaction")) return;
    try {
      applyActionResult(await window.tau!.compactContext());
      setNotice("Context compacted.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  /** Pi's `!command` for extensions: runs in the active thread's project. */
  const runShellAction = useCallback(async (command: string, includeInContext: boolean): Promise<ShellActionResult> => {
    if (!window.tau) throw new Error("Project actions require the Electron host");
    return window.tau.runShellAction(command, includeInContext, snapshot?.cwd);
  }, [snapshot?.cwd]);

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
    const prompt = uiPromptsRef.current.find((entry) => entry.id === id);
    if (prompt) registry.notifyPromptAnswered(prompt, answer);
    setUiPrompts((current) => current.filter((entry) => entry.id !== id));
    void window.tau?.answerExtensionUi(id, answer);
  }, [registry]);

  const settleActiveThread = useCallback(() => {
    const activeId = threadStore.getSnapshot().activeThreadId;
    if (!activeId) return;
    preferences.toggleSettled(activeId);
  }, [threadStore]);

  const copyThreadValue = useCallback(async (kind: "chat" | "path" | "thread-id") => {
    if (kind === "chat") {
      if (!snapshot?.sessionId || !window.tau) return;
      try {
        await window.tau.copyThreadMarkdown(snapshot.sessionId);
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
      await window.tau?.copyText(value);
      setNotice(`${kind === "path" ? "Path" : "Thread ID"} copied.`);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [snapshot?.cwd, snapshot?.sessionId]);

  const copyMessage = useCallback(async (message: UiMessage) => {
    try {
      const copyText = message.role === "user"
        ? message.skill?.copyText ?? visibleUserMessageText(message.text)
        : message.text;
      await window.tau?.copyText(copyText);
      setNotice("Message copied.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, []);

  const copyToolOutput = useCallback(async (tool: UiToolRun) => {
    if (!snapshot?.sessionId || !window.tau) {
      setNotice("Tool output is unavailable.");
      return;
    }
    try {
      const result = await window.tau.readToolOutput(snapshot.sessionId, tool.id);
      if (!result) throw new Error("The complete tool output is no longer available.");
      await window.tau.copyText(result.output);
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
      applyActionResult(await window.tau!.forkThread(message.sourceEntryId, snapshot.sessionId));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  // Pi's /tree, /fork and /clone for the thread on screen.
  const [threadTreeModal, setThreadTreeModal] = useState<{ mode: ThreadTreeMode; tree?: UiThreadTree; error?: string; busy: boolean }>();
  const openThreadTree = useCallback((mode: ThreadTreeMode = "navigate") => {
    if (!requireHost("Thread tree")) return;
    setThreadTreeModal({ mode, busy: false });
    window.tau!.threadTree(snapshot?.sessionId)
      .then((tree) => setThreadTreeModal((current) => current && { ...current, tree }))
      .catch((error) => setThreadTreeModal((current) => current && { ...current, error: errorMessage(error) }));
  }, [requireHost, snapshot?.sessionId]);
  const navigateThreadTree = useCallback(async (entryId: string, summarize: boolean) => {
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      const result = await window.tau!.navigateThreadTree(entryId, { summarize }, snapshot?.sessionId);
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
      applyActionResult(await window.tau!.forkThread(entryId, snapshot?.sessionId));
      setThreadTreeModal(undefined);
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, snapshot?.sessionId]);
  const duplicateThread = useCallback(async () => {
    if (!requireHost("Duplicate thread")) return false;
    try {
      setNotice("Duplicating thread…");
      applyActionResult(await window.tau!.duplicateThread(snapshot?.sessionId));
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  const applyPreparedReload = useCallback(async () => {
    setReloadPhase("building");
    try {
      const result = await window.tau!.rebuildWorkbench();
      if (!result.ok) {
        setReloadPhase(undefined);
        await window.tau!.releaseWorkbenchReload();
        addEvent("workbench.build.failed", result.output);
        setNotice(`Build failed: ${result.output.split("\n").filter(Boolean).at(-1) ?? "see Signals"}`);
        return false;
      }
      setReloadPhase("extensions");
      await window.tau!.reloadRuntime();
      if (result.mainChanged) {
        setReloadPhase("restarting");
        await window.tau!.relaunchWorkbench();
      } else {
        await window.tau!.releaseWorkbenchReload();
        window.location.reload();
      }
      return true;
    } catch (error) {
      setReloadPhase(undefined);
      await window.tau!.releaseWorkbenchReload().catch(() => undefined);
      setNotice(errorMessage(error));
      return false;
    }
  }, [addEvent, setNotice]);

  const reloadWorkbench = useCallback(async () => {
    if (!requireHost("Reloading")) return false;
    try {
      const preparation = await window.tau!.prepareWorkbenchReload("inspect");
      if (!preparation.ready) {
        setReloadConflictCount(preparation.runningThreads);
        return true;
      }
      return applyPreparedReload();
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyPreparedReload, requireHost, setNotice]);

  const continueConflictedReload = useCallback(async (mode: "wait" | "abort") => {
    setReloadConflictCount(undefined);
    if (mode === "wait") setNotice("Reload queued until running threads finish.");
    try {
      await window.tau!.prepareWorkbenchReload(mode);
      setNotice(undefined);
      await applyPreparedReload();
    } catch (error) {
      await window.tau!.releaseWorkbenchReload().catch(() => undefined);
      setNotice(errorMessage(error));
    }
  }, [applyPreparedReload, setNotice]);

  const actions: WorkbenchActions = useMemo(() => ({
    openPanel,
    openCommandPalette: () => setPaletteOpen(true),
    openSettings: (page) => setSettingsPage(page ?? "defaults"),
    newSession: () => setNewThreadOpen(true),
    switchSession,
    settleActiveThread,
    // Escape is bound to this; only a visibly running thread has anything to stop.
    abort: () => { if (visibleStreamingRef.current) void window.tau?.abort(threadStore.getSnapshot().activeThreadId || undefined); },
    reloadWorkbench,
    openThreadTree,
    duplicateThread,
    focusComposer: (seed) => { if (seed !== undefined) setComposerSeed(seed); composerRef.current?.focus(); },
    notify: setNotice,
    openProjectSources: () => { setNewThreadOpen(false); setProjectSourcesOpen(true); },
    applyHostResult,
    openOverlay: (id) => setActiveOverlayId(id),
    closeOverlay: () => setActiveOverlayId(undefined),
    openWorkspace,
    activeThread: () => ({
      sessionId: pendingNewThread ? undefined : snapshot?.sessionId,
      cwd: workspaceCwd,
      model: snapshot?.model,
      draftPending: newThreadDeliveryPending,
    }),
    openFile,
    runShellAction,
    holdComposer: () => { setComposerHolds((count) => count + 1); return () => setComposerHolds((count) => Math.max(0, count - 1)); },
    composerDraft: () => activeDraftKey ? composerScopeStore.getSnapshot(activeDraftKey).draft : "",
  }), [
    applyHostResult, openPanel,
    activeDraftKey, openWorkspace, reloadWorkbench, settleActiveThread, snapshot, switchSession,
    openThreadTree, duplicateThread,
  ]);
  actionsRef.current = actions;

  const completeNewThreadSubmission = useCallback((completion: NewThreadSubmissionCompletion) => {
    const { pending, sessionId, optimisticId, prompt, scope, requestId, result, recovery } = completion;
    if (!isCurrentNewThreadRequest(pending, scope, requestId)) return;
    setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimisticId
      ? { ...entry, scope: `session:${sessionId}` }
      : entry));
    if (scope) {
      composerScopeStore.moveScope(createDraftKey(scope), createDraftKey(draftKey(sessionId)));
    }
    writeNewThreadDraft(window.localStorage);
    setPendingNewThread(undefined);
    if (result) applyHostResult(result);
    threadStore.markRead(sessionId);
    notifyNewThreadPromptSubmitted(pending, sessionId, prompt, recovery);
  }, [applyHostResult, composerScopeStore, isCurrentNewThreadRequest, notifyNewThreadPromptSubmitted, setPendingNewThread, threadStore]);

  const submit = useCallback(async (
    value: string,
    attachments: UiPromptAttachment[] = [],
    delivery?: "followUp" | "steer",
    skillDraft?: UiSkillDraft,
  ): Promise<SubmitResult> => {
    const text = skillDraft ? value : value.trim();
    const commandText = text.trim();
    if (!commandText && attachments.length === 0) return { accepted: false, message: "Enter a message or attach an image." };
    // Desktop extensions own slash commands the runtime never sees.
    const slash = attachments.length === 0 && !skillDraft ? registry.findSlashCommand(commandText) : undefined;
    if (slash) {
      try {
        const message = await slash.command.run(slash.args, actions);
        return message ? { accepted: false, message } : { accepted: true };
      } catch (error) {
        return { accepted: false, message: errorMessage(error) };
      }
    }
    // Enter during a run parks the message above the composer. It is prepared
    // and sent as a plain prompt once the thread settles, or steered on demand.
    if (!pendingNewThread && snapshot && visibleStreaming && delivery !== "steer") {
      enqueueFollowUp(snapshot.sessionId, { text: value, attachments, ...(skillDraft ? { skillDraft } : {}) });
      return { accepted: true };
    }
    let prepared: PreparedPrompt | undefined;
    if (window.tau?.preparePrompt) {
      try {
        prepared = await window.tau.preparePrompt(
          text,
          pendingNewThread ? undefined : snapshot?.sessionId,
          skillDraft,
        );
      } catch (error) {
        // ComposerScopeStore keeps the captured draft when a submission is
        // rejected, including edits made while preflight was in flight.
        // Re-seeding here would overwrite those newer edits.
        setNotice(String(error));
        return { accepted: false, message: errorMessage(error) };
      }
    }
    const optimisticText = prepared?.visibleText
      ?? skillDraft?.visibleText
      ?? (text || `Attached ${attachments.map((attachment) => attachment.name).join(", ")}`);
    const visiblePrompt = prepared?.visibleText ?? skillDraft?.visibleText ?? text;
    const optimisticSkill = prepared
      ? prepared.skill
      : skillDraft ? skillPresentationForDraft(skillDraft) : undefined;
    const submittedAt = Date.now();
    const turnSequence = transcriptTurnSequenceRef.current++;
    const logicalTurnId = `turn-${submittedAt}-${turnSequence}`;
    const clientMessageId = createClientMessageId();
    const optimistic: UiMessage = {
      id: `local-${clientMessageId}`,
      clientTurnId: logicalTurnId,
      clientMessageId,
      role: "user",
      text: optimisticText,
      ...(optimisticSkill ? { skill: optimisticSkill } : {}),
      images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
      timestamp: submittedAt,
    };
    const newThreadRequestId = newThreadRequestRef.current;
    const clientTurn: ClientTurnIdentity = {
      clientTurnId: logicalTurnId,
      clientMessageId,
      ...(newThreadRequestId ? { newThreadRequestId } : {}),
    };
    const submissionScopeKey = transcriptScopeKey;
    const submissionScope = transcriptNavigationScope(snapshot, pendingNewThread);
    const submissionDraftId = pendingNewThread?.draftId;
    const submissionRequestId = logicalTurnId;
    const submissionIdentity: TranscriptSubmissionIdentity = {
      turnId: submissionRequestId,
      scopeKey: submissionScopeKey,
      scope: submissionScope,
      draftId: submissionDraftId,
    };
    const isCurrentSubmission = () => isCurrentTranscriptSubmission(
      transcriptTurnStartRef.current,
      transcriptScopeKeyRef.current,
      pendingNewThreadRef.current?.draftId,
      submissionIdentity,
    );
    const startTranscriptTurn = (
      targetSessionId?: string,
      awaitingMessage = false,
      preserveAcrossSessionChange = false,
    ) => {
      const nextTurnStart: TranscriptTurnStart = {
        turnId: logicalTurnId,
        scope: submissionScope,
        sessionId: targetSessionId,
        messageId: awaitingMessage ? undefined : optimistic.id,
        clientMessageId: clientTurn.clientMessageId,
        text: optimistic.text,
        timestamp: optimistic.timestamp,
        awaitingMessage,
        preserveAcrossSessionChange,
        scopeKey: submissionScopeKey,
      };
      setTranscriptTurnStart(nextTurnStart);
    };
    const cancelTranscriptTurn = () => {
      setTranscriptTurnStart(undefined, logicalTurnId);
    };
    const submittedDraftKey = activeDraftKey;
    const optimisticScope = submittedDraftKey ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    if (!pendingNewThread && visibleStreaming) {
      setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      startTranscriptTurn(snapshot?.sessionId);
      try {
        if (!window.tau) throw new Error("Steering requires the Electron host.");
        await window.tau.steer(text, attachments, snapshot?.sessionId, clientTurn, prepared);
      } catch (error) {
        const currentSubmission = isCurrentSubmission();
        cancelTranscriptTurn();
        setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
        if (currentSubmission) {
          setNotice(String(error));
        }
        return { accepted: false, message: errorMessage(error) };
      }
      return { accepted: true };
    }
    if (pendingNewThread) {
      const pending = pendingNewThread;
      const pendingKey = draftKey(undefined, pending);
      const recovery: NewThreadSubmissionRecovery | undefined = submittedDraftKey
        ? {
          pending,
          requestId: newThreadRequestId,
          scopeRef: composerScopeStore.createScopeReference(submittedDraftKey),
          draft: text,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: allocateAttachmentId(),
            previewUrl: `data:${attachment.mimeType};base64,${attachment.data}`,
          })),
          optimistic,
          ipcPending: true,
        }
        : undefined;
      if (recovery) {
        newThreadRecoveryRef.current.set(clientMessageId, recovery);
        setNewThreadRecoveryVersion((version) => version + 1);
      }
      startTranscriptTurn(pending.sessionId, false, true);
      setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      try {
        if (!window.tau) throw new Error("New thread requires the Electron host.");
        if (pending.sessionId) {
          await window.tau.sendPrompt(text, attachments, pending.sessionId, clientTurn, prepared);
          settleNewThreadRecoveryIpc(clientMessageId, recovery);
          if (recovery?.failed) {
            releaseNewThreadRecovery(clientMessageId);
            return { accepted: false, message: recovery.failed };
          }
          // Unlike newSession, this call resolves at the runtime's own delivery
          // acceptance, so returning from it is the commit. A correlated user
          // message may have committed it first; then there is nothing to do.
          if (!recovery?.promoted) {
            completeNewThreadSubmission({ pending, sessionId: pending.sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId, recovery });
          }
          releaseNewThreadRecovery(clientMessageId);
          return { accepted: true };
        }
        const result = await window.tau.newSession(text, attachments, pending.projectPath, clientTurn, prepared);
        settleNewThreadRecoveryIpc(clientMessageId, recovery);
        if (recovery?.failed) {
          releaseNewThreadRecovery(clientMessageId);
          return { accepted: false, message: recovery.failed };
        }
        // A session id is only the runtime binding, never the delivery commit.
        // Record it so a late failure retries in this session instead of
        // allocating a second runtime.
        if (recovery && result.sessionId) recovery.sessionId = result.sessionId;
        // A correlated user message may have promoted the draft while the
        // newSession IPC call was still pending. Its scope and active thread
        // are already correct, but the result still carries authoritative
        // shell, detail, catalog and project updates that must not be dropped.
        // They pass through the normal race guard rather than being forced.
        if (recovery?.promoted && result.submission.accepted) {
          result.updates.forEach((update) => applyHostUpdate(update));
          return { accepted: true };
        }
        if (!isCurrentNewThreadRequest(pending, submittedDraftKey, newThreadRequestId)) {
          releaseNewThreadRecovery(clientMessageId);
          return result.submission;
        }
        const created = result.updates.find((update) => update.type === "thread-detail");
        if (result.submission.accepted
          && created?.type !== "thread-detail"
          && result.requestId === newThreadRequestId) {
          markAwaitingPromotion({ pending, scope: submittedDraftKey, requestId: newThreadRequestId });
        }
        applyActionResult(result);
        if (!result.submission.accepted) {
          const rejectedDetail = result.updates.find((update) => update.type === "thread-detail");
          const sessionId = rejectedDetail?.type === "thread-detail" ? rejectedDetail.detail.sessionId : undefined;
          if (sessionId) {
            if (isCurrentNewThreadRequest(pending, submittedDraftKey, newThreadRequestId)) {
              setPendingNewThread((current) => current ? { ...current, sessionId } : current);
              writeNewThreadDraft(window.localStorage, { ...pending, sessionId });
            }
          }
          setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
          releaseNewThreadRecovery(clientMessageId);
          return result.submission;
        }
        const sessionId = created?.type === "thread-detail" ? created.detail.sessionId : undefined;
        if (transcriptTurnStartRef.current?.turnId !== logicalTurnId
          || transcriptScopeKeyRef.current !== submissionScopeKey
          || pendingNewThreadRef.current?.draftId !== pending.draftId) {
          // The draft was abandoned while the host was creating its session.
          // Do not let a late result switch the newly selected thread back.
          writeComposerDraft(window.localStorage, pendingKey, "");
          releaseNewThreadRecovery(clientMessageId);
          return result.submission;
        }
        if (sessionId) {
          if (recovery) recovery.sessionId = sessionId;
          // The optimistic message moves to the real thread before the draft
          // view closes, so nothing flickers while the host confirms it.
          setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id
            ? { ...entry, scope: `session:${sessionId}` }
            : entry));
          const persistedPrompt = created?.type === "thread-detail"
            ? created.detail.messages.find((message) => matchesTranscriptTurnMessage(message, {
              turnId: clientTurn.clientTurnId,
              clientMessageId: clientTurn.clientMessageId,
              messageId: optimistic.id,
              text: optimistic.text,
              timestamp: optimistic.timestamp,
            }))
            : undefined;
          if (transcriptTurnStartRef.current?.turnId === logicalTurnId) {
            const nextTurnStart = {
              ...transcriptTurnStartRef.current,
              sessionId,
              scope: { kind: "session" as const, projectPath: pending.projectPath, sessionId },
              messageId: persistedPrompt?.id ?? transcriptTurnStartRef.current.messageId,
              scopeKey: transcriptNavigationScopeKey({ cwd: pending.projectPath, sessionId }),
            };
            setTranscriptTurnStart(nextTurnStart, logicalTurnId);
          }
          if (recovery) {
            // Delivery is detached from this acknowledgement. A prompt already
            // persisted in the result is itself the commit; otherwise the
            // host's settlement event completes the submission.
            if (persistedPrompt) promoteRecoveryToSession(clientMessageId, sessionId, persistedPrompt);
            return { accepted: true };
          }
          completeNewThreadSubmission({ pending, sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId, result });
          return { accepted: true };
        } else {
          // Pi's own TUI creates the thread and reports it later; the draft
          // view stays until that report arrives.
          return { accepted: true };
        }
      } catch (error) {
        releaseNewThreadRecovery(clientMessageId);
        const currentSubmission = isCurrentSubmission();
        cancelTranscriptTurn();
        setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
        if (currentSubmission) {
          setNotice(String(error));
        }
        return { accepted: false, message: errorMessage(error) };
      }
    }
    if (snapshot) {
      threadStore.markRead(snapshot.sessionId);
      preferences.unsettle(snapshot.sessionId);
    }
    startTranscriptTurn(snapshot?.sessionId);
    setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
    if (window.tau) {
      try {
        await window.tau.sendPrompt(text, attachments, snapshot?.sessionId, clientTurn, prepared);
        void registry.notifyPromptSubmitted({ prompt: visiblePrompt, snapshot }, actions)
          .catch((error) => setNotice(errorMessage(error)));
        return { accepted: true };
      } catch (error) {
        const currentSubmission = isCurrentSubmission();
        cancelTranscriptTurn();
        setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
        if (currentSubmission) {
          setNotice(String(error));
        }
        return { accepted: false, message: errorMessage(error) };
      }
    } else {
      setSnapshot((current) => current ? { ...current, isStreaming: true } : current);
      setRunStartedAt(Date.now());
      window.setTimeout(() => {
        appendTranscriptMessage({
          id: `mock-${Date.now()}`,
          role: "assistant",
          text: "Preview mode received the prompt. Launch `npm start` to send it through the real Pi SDK.",
          timestamp: Date.now(),
        });
        setSnapshot((current) => current ? { ...current, isStreaming: false } : current);
        setRunStartedAt(undefined);
      }, 650);
      return { accepted: true };
    }
  }, [applyHostResult, actions, activeDraftKey, appendTranscriptMessage, applyActionResult, completeNewThreadSubmission, enqueueFollowUp, isCurrentNewThreadRequest, pendingNewThread, promoteRecoveryToSession, registry, setTranscriptTurnStart, snapshot, threadStore, transcriptScopeKey, visibleStreaming]);
  submitRef.current = submit;

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
    writeCachedTurnActivity(window.localStorage, {
      sessionId,
      tools,
      anchorMessageId: toolAnchorId,
    });
  }, [snapshot?.sessionId, toolAnchorId, tools, turnActivitySessionId]);
  const activityTools = useMemo(() => tools.filter((tool) => tool.name !== "todo"), [tools]);
  const contextBreakdown: ContextBreakdown = useMemo(() => {
    const usage = snapshot?.contextUsage;
    if (!usage) return { messages: 0, toolOutput: 0, system: 0 };
    const messageTokens = transcriptTokenEstimate;
    const toolTokens = tools.reduce((total, tool) => total + estimateTokens(tool.output ?? ""), 0);
    const accounted = Math.min(usage.tokens, messageTokens + toolTokens);
    const scale = messageTokens + toolTokens > 0 ? accounted / (messageTokens + toolTokens) : 0;
    return {
      messages: Math.round(messageTokens * scale),
      toolOutput: Math.round(toolTokens * scale),
      system: Math.max(0, usage.tokens - accounted),
    };
  }, [snapshot?.contextUsage, tools, transcriptTokenEstimate]);

  const stageTab = activeStageTab(stage);
  const stageFilePath = stageTab?.path;
  const contextValue = useMemo(
    () => ({ snapshot, tools, events, registry, activeDocumentPath: stageFilePath, openFile, applySnapshot, handleHostEvent }),
    [snapshot, tools, events, registry, stageFilePath, openFile, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot, registry }), [snapshot, registry]);
  const observatoryContextValue = useMemo(() => ({ events, snapshot, tools, registry }), [events, snapshot, tools, registry]);
  // The stage shows documents; whoever registered the document source loads them.
  const documentSource = registry.getDocumentSource();
  const documentState = useSyncExternalStore(documentSource?.subscribe ?? noopSubscribe, documentSource?.getState ?? emptyDocumentState, documentSource?.getState ?? emptyDocumentState);
  const sidebarContributions = registry.getSidebarContributions();
  const commands = registry.getCommands();
  const titleCommands = registry.getCommandsFor("thread-title");
  const scopedOptimisticMessages = useMemo(
    () => optimisticMessages.filter((entry) => entry.scope === activeDraftKey),
    [activeDraftKey, optimisticMessages],
  );
  const unconfirmedOptimisticMessages = useMemo(
    () => reconcileOptimisticMessages(scopedOptimisticMessages, messages).map((entry) => entry.message),
    // `userRevision` lives in the mutable transcript index and can become
    // visible in a higher-priority render before the matching messages state.
    // The array dependency makes the later authoritative commit reconcile too.
    [messages, scopedOptimisticMessages, transcriptUserRevision],
  );
  const preparedThreadCapability = usePreparedThreadCapability(
    pendingNewThread?.sessionId ? undefined : pendingNewThread?.projectPath,
    window.tau?.getPreparedThreadCapability,
  );
  const conversationMessages = useMemo(() => pendingNewThread
    ? unconfirmedOptimisticMessages
    : mergeTranscriptMessages(messages, unconfirmedOptimisticMessages),
  [messages, pendingNewThread, unconfirmedOptimisticMessages]);
  const visibleToolAnchorId = visibleStreaming
    ? latestActivityAnchor(conversationMessages)
    // A submitted prompt is visible before its run starts. Keep the previous
    // settled group on its original turn until agent-status opens new work.
    : toolAnchorId ?? latestActivityAnchor(conversationMessages);
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
    pendingAssistantAnchors: pendingAssistantAnchorsRef, messages: messagesRef, setMessages,
    recoverThread, copyToolOutput, abortSessionId: snapshot?.sessionId,
  });
  const showStartScreen = conversationMessages.length === 0
    && !conversationSnapshot?.isStreaming
    && conversationActivityTools.length === 0
    && conversationPrompts.length === 0;
  const startProjectPath = conversationSnapshot?.cwd ?? "";
  const startProjectName = pendingNewThread?.projectName
    ?? projects.find((project) => project.path === startProjectPath)?.name
    ?? startProjectPath.split(/[\\/]/u).filter(Boolean).at(-1)
    ?? startProjectPath;
  return <>
    <Workbench model={{
    registry, actions, threadStore, context: contextValue, shellContext: shellContextValue,
    observatoryContext: observatoryContextValue, snapshot, workspaceCwd, dockOpen, setDockOpen,
    sidebarContributions, panels, activePanel, openedPanels, openPanel, centerRef, centerCompact,
    setCenterCompact, chatFocused, setChatFocused, stage, setStage, documentState, documentSource,
    visibleStreaming, showStartScreen, startProjectPath, startProjectName, setNewThreadOpen,
    dropController: threadDropController, conversationSnapshot, composerScopeStore, composerSeed,
    activeDraftKey, queue, contextBreakdown, composerRef, composerAttachmentRef, submit, cancelQueued, steerQueued, reorderQueue,
    setModel, setThinking, conversationPrompts, answerUiPrompt, compactContext, composerHolds,
    settings, titleCommands, openThreadTree, duplicateThread, settleActiveThread, renameThread,
    copyThreadValue, pendingNewThread: Boolean(pendingNewThread), conversationMessages,
    transcriptHistory, transcriptRef, loadTranscriptPage, applyTranscriptPage, transcriptScopeKey,
    transcriptRevision, transcriptLookupRevision, transcriptScope, transcriptTurnStart,
    visibleTranscriptTurnStart, transcriptActivities, liveStatusLabel, conversationActivityTools,
    runStartedAt, copyMessage, forkMessage, threadTreeModal, setThreadTreeModal,
    navigateThreadTree, forkFromTree, paletteOpen, setPaletteOpen, commands, projectSourcesOpen,
    setProjectSourcesOpen, newThreadOpen, projects, removeProject, createThreadInProject,
    settingsPage, setSettingsPage, notice, noticeLevel, setNotice, activeOverlayId,
    setActiveOverlayId,
  }} />
    {reloadConflictCount !== undefined ? <ReloadConflictDialog
      runningThreads={reloadConflictCount}
      onCancel={() => setReloadConflictCount(undefined)}
      onWait={() => void continueConflictedReload("wait")}
      onAbort={() => void continueConflictedReload("abort")}
    /> : null}
    {reloadPhase ? <ReloadCurtain phase={reloadPhase} /> : null}
  </>;
}
