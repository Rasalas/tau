import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import { ChevronDown, Folder, PanelRight, PanelRightClose } from "lucide-react";
import type {
  FileNode,
  HostEvent,
  HostSnapshot,
  ThreadIndexSnapshot,
  UiEditor,
  UiMessage,
  UiProject,
  UiPromptAttachment,
  UiSession,
  UiTaskProgressEntry,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  ServiceTier,
  ToolApprovalRequest,
  UiToolRun,
  UiWorkspaceChanges,
  WorkspaceInfo,
} from "../shared/contracts";
import { ChangedFiles } from "./components/ChangedFiles";
import { changesSinceTurn, changesTouchedByTools, clearCachedTurnActivity, readCachedTurnActivity, writeCachedTurnActivity } from "./turn-activity";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { Composer } from "./components/Composer";
import { multiSelectValue, type QuestionnaireChoice } from "./components/ExtensionPrompt";
import { optionForLabel, splitOption } from "../shared/extension-prompt-options";
import type { ContextBreakdown } from "./components/ContextMeter";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
const LazyCommandPalette = lazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const LazyReviewMode = lazy(() => import("./components/ReviewMode").then(({ ReviewMode }) => ({ default: ReviewMode })));
const LazySettingsModal = lazy(() => import("./components/SettingsModal").then(({ SettingsModal }) => ({ default: SettingsModal })));


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

import { TitleBar } from "./components/TitleBar";
import { ToolApproval } from "./components/ToolApproval";
import { PanelIcon } from "./components/PanelIcon";
import { ToolGroup } from "./components/ToolGroup";
import { VirtualTranscript } from "./components/VirtualTranscript";
import { TaskProgress } from "./components/TaskProgress";
import { ProjectPicker } from "./components/ProjectPicker";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";
import { bundledExtensions } from "./extensions";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { preferences, type AccessLevel } from "./preferences";
import { draftKey, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { ThreadStore } from "./thread-store";
import { RuntimeExtensions, installSharedModules } from "./runtime-extensions";
import { displayPath } from "./path-display";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import type { HostActionResult, HostUpdate, ThreadDetail } from "../shared/host-protocol";
import {
  ThreadStoreContext,
  WorkbenchContext,
  WorkbenchShellContext,
  FilesContext,
  ChangesContext,
  ObservatoryContext,
  type TimelineEvent,
} from "./workbench-context";
import { TranscriptHistoryControl, type TranscriptHistoryStatus } from "./components/TranscriptHistoryControl";
import { countUserTurns } from "../shared/transcript-pager";

const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };

function questionKey(sessionId: string, index: number): string {
  return `${sessionId}:${index}`;
}

export function optimisticThreadSnapshot(
  snapshot: HostSnapshot,
  target: UiSession,
  detail: ThreadDetail,
): HostSnapshot {
  return {
    ...snapshot,
    sessionId: detail.sessionId,
    sessionName: undefined,
    sessionTitle: target.title,
    branch: target.branch,
    messages: detail.messages,
    olderCursor: detail.olderCursor,
    isStreaming: false,
    activeTools: detail.activeTools,
    turnActivity: detail.turnActivity,
    taskProgress: detail.taskProgress,
    taskHistory: detail.taskHistory,
    contextUsage: detail.contextUsage,
  };
}

/** Merge a page without allowing a repeated or late response to duplicate rows. */
export function mergeTranscriptMessages(
  current: readonly UiMessage[],
  incoming: readonly UiMessage[],
  position: "prepend" | "append" = "append",
): UiMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message] as const));
  const retainedIds = new Set<string>();
  const retained = current.flatMap((message) => {
    if (retainedIds.has(message.id)) return [];
    retainedIds.add(message.id);
    return [incomingById.get(message.id) ?? message];
  });
  const additionIds = new Set<string>();
  const additions = incoming.flatMap((message) => {
    if (retainedIds.has(message.id) || additionIds.has(message.id)) return [];
    additionIds.add(message.id);
    return [incomingById.get(message.id) ?? message];
  });
  return position === "prepend" ? [...additions, ...retained] : [...retained, ...additions];
}

function mergeTaskHistory(
  current: readonly UiTaskProgressEntry[] | undefined,
  incoming: readonly UiTaskProgressEntry[] | undefined,
): UiTaskProgressEntry[] | undefined {
  if (!current && !incoming) return undefined;
  const byId = new Map<string, UiTaskProgressEntry>();
  for (const entry of current ?? []) byId.set(entry.id, entry);
  for (const entry of incoming ?? []) byId.set(entry.id, entry);
  return [...byId.values()];
}

function retainsLoadedHistory(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): current is ThreadDetail {
  if (!current || current.sessionId !== incoming.sessionId || current.messages.length <= incoming.messages.length || incoming.messages.length === 0) return false;
  const currentIds = new Set(current.messages.map((message) => message.id));
  return incoming.messages.some((message) => currentIds.has(message.id));
}

/** Keep the first visible transcript content at the same viewport offset after a prepend. */
export function restoreTranscriptScrollPosition(
  node: Pick<HTMLDivElement, "scrollHeight" | "scrollTop">,
  previousHeight: number,
  previousScrollTop: number,
): number {
  const delta = node.scrollHeight - previousHeight;
  node.scrollTop = previousScrollTop + delta;
  return delta;
}

const mockSnapshot: HostSnapshot = {
  cwd: "/workspace/tau",
  branch: "main",
  sessionId: "prototype-preview",
  sessionName: "Split host snapshots & virtualize the thread list",
  sessionTitle: "Split host snapshots & virtualize the thread list",
  model: { provider: "anthropic", id: "preview", name: "sonnet-4.6" },
  models: [{ provider: "anthropic", id: "preview", name: "sonnet-4.6" }],
  thinkingLevel: "high",
  thinkingLevels: ["off", "low", "medium", "high"],
  serviceTier: "standard",
  serviceTierAvailable: true,
  messages: [
    { id: "welcome-user", role: "user", text: "Split the full host snapshots, stop calling SessionManager.listAll() on every switch, and virtualize the thread list for large sessions.", timestamp: Date.now() - 120000 },
    { id: "welcome-pi", role: "assistant", text: "Core keeps thread and session semantics; extensions only subscribe to individual thread shells. Press ⌘K to inspect the contribution registry.", timestamp: Date.now() - 110000 },
  ],
  isStreaming: false,
  activeTools: ["read", "bash", "edit", "write"],
  allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, description: `${name} tool` })),
  extensionCount: 2,
  contextUsage: { tokens: 68000, contextWindow: 200000, percent: 34 },
};

const mockThreadIndex: ThreadIndexSnapshot = {
  projects: [
    { path: "/workspace/tau", name: "tau", lastOpenedAt: Date.now() },
    { path: "/workspace/pi", name: "pi-coding-agent", lastOpenedAt: Date.now() - 7200000 },
    { path: "/workspace/lab", name: "agent-lab", lastOpenedAt: Date.now() - 86400000 },
  ],
  sessions: [
    { id: "prototype-preview", path: "preview", title: "Split host snapshots & virtualize the thread list", modifiedAt: Date.now(), projectPath: "/workspace/tau", projectName: "tau", branch: "main", messageCount: 12 },
    { id: "second", path: "second", title: "Renderer experiment", modifiedAt: Date.now() - 860000, projectPath: "/workspace/pi", projectName: "pi-coding-agent", branch: "feat/desktop-host", messageCount: 7 },
    { id: "third", path: "third", title: "Package both extension domains", modifiedAt: Date.now() - 7200000, projectPath: "/workspace/lab", projectName: "agent-lab", branch: "main", messageCount: 18 },
  ],
};

/** chars/4, the same heuristic the Pi SDK uses, so the dial's split is a real estimate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function latestActivityAnchor(
  messages: readonly UiMessage[],
  currentAnchorId?: string,
): string | undefined {
  if (!currentAnchorId) return messages.at(-1)?.id;
  const currentIndex = messages.findIndex((message) => message.id === currentAnchorId);
  if (currentIndex < 0) return messages.at(-1)?.id;
  for (let index = messages.length - 1; index > currentIndex; index -= 1) {
    if (messages[index]?.role === "user") return messages[index].id;
  }
  return currentAnchorId;
}

interface OptimisticUserMessage {
  scope: string;
  message: UiMessage;
}

export function reconcileOptimisticMessages(
  pending: readonly OptimisticUserMessage[],
  authoritative: readonly UiMessage[],
): OptimisticUserMessage[] {
  const confirmed = authoritative.filter((message) => message.role === "user");
  const used = new Set<number>();
  return pending.filter((entry) => {
    const index = confirmed.findIndex((message, at) =>
      !used.has(at)
      && message.text === entry.message.text
      && message.timestamp >= entry.message.timestamp - 30_000,
    );
    if (index < 0) return true;
    used.add(index);
    return false;
  });
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function LiveStatus({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="live-status"><span className="spinner" /><span>Pi is working{startedAt ? ` · ${elapsedLabel(now - startedAt)}` : ""}</span></div>;
}

export function useTailScroll(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  resetKey?: unknown,
  preserveScrollRef?: RefObject<boolean | undefined>,
): void {
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | undefined>(undefined);
  const scheduleTail = () => {
    if (preserveScrollRef?.current) {
      pinnedRef.current = false;
      return;
    }
    if (!pinnedRef.current || frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const node = ref.current;
      if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
    });
  };

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // A fresh transcript starts at scrollTop 0 even when it is several screens
    // tall. Treat it as pinned until the first tail placement completes.
    pinnedRef.current = true;
    let pointerDown = false;
    let touchY: number | undefined;
    const nearTail = () => node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    const onScroll = () => {
      if (nearTail()) pinnedRef.current = true;
      else if (pointerDown) pinnedRef.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pinnedRef.current = false;
    };
    const onPointerDown = () => { pointerDown = true; };
    const onPointerUp = () => { pointerDown = false; };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY) pinnedRef.current = false;
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pinnedRef.current = false;
      if (event.key === "End") pinnedRef.current = true;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    const content = node.firstElementChild ?? node;
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => scheduleTail());
    observer?.observe(content);
    scheduleTail();
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [ref, resetKey]);

  useEffect(() => {
    if (preserveScrollRef?.current) {
      pinnedRef.current = false;
      return;
    }
    scheduleTail();
  // The array identity is intentionally controlled by the caller's visible records.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, updates);
}

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
  useSyncExternalStore(registry.subscribe, registry.getVersion);
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
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const threadActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);

  const [snapshot, setSnapshot] = useState<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  // Run state lives in the thread store, fed by the host's per-thread status
  // events. Deriving it here keeps the composer, the live row and the rail from
  // ever disagreeing about whether the visible thread is working.
  const visibleStreaming = Boolean(snapshot && threadActivity.runningThreadIds.includes(snapshot.sessionId));
  const [messages, setMessages] = useState<UiMessage[]>(cachedBootstrap?.snapshot.messages ?? []);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);
  const [tools, setTools] = useState<UiToolRun[]>([]);
  const [toolAnchorId, setToolAnchorId] = useState<string>();
  const [turnActivitySessionId, setTurnActivitySessionId] = useState<string>();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [changes, setChanges] = useState<UiWorkspaceChanges>(NO_CHANGES);
  const [turnBaseline, setTurnBaseline] = useState<UiWorkspaceChanges>();
  const [editors, setEditors] = useState<UiEditor[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [approvals, setApprovals] = useState<ToolApprovalRequest[]>([]);
  const [uiPrompts, setUiPrompts] = useState<ExtensionUiPrompt[]>([]);
  const uiPromptsRef = useRef(uiPrompts);
  uiPromptsRef.current = uiPrompts;
  // Picks per questionnaire question, keyed by thread and index. A pick for a
  // question the extension has not reached yet is sent the moment it asks.
  const [questionnaireChoices, setQuestionnaireChoices] = useState<Record<string, QuestionnaireChoice>>({});
  const questionnaireChoicesRef = useRef(questionnaireChoices);
  questionnaireChoicesRef.current = questionnaireChoices;
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [activePanel, setActivePanel] = useState("");
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [pendingNewThread, setPendingNewThread] = useState<NewThreadDraft | undefined>(() => readNewThreadDraft(window.localStorage));
  const [settingsPage, setSettingsPage] = useState<string>();
  const [review, setReview] = useState<{ path?: string; primaryPush: boolean }>();
  const [committing, setCommitting] = useState(false);
  const [composerSeed, setComposerSeed] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dockOpen, setDockOpen] = useState(true);
  const [olderCursor, setOlderCursor] = useState<string | undefined>(cachedBootstrap?.snapshot.olderCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<TranscriptHistoryStatus>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptPrependRef = useRef<boolean | undefined>(undefined);
  const detailStoreRef = useRef(new ThreadDetailStore(5));
  const cachedSnapshotRef = useRef<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const snapshotRef = useRef<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const activeSessionRef = useRef(cachedBootstrap?.snapshot.sessionId ?? "");
  const pendingSessionRef = useRef<{ switching: boolean; sessionId?: string }>({ switching: false });
  const bootstrappedRef = useRef(false);
  const transcriptLoadRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const activeWorkspaceRef = useRef(cachedBootstrap?.snapshot.cwd ?? "");
  const changesRequestRef = useRef(0);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const workspaceRequestRef = useRef(0);
  const cachedIndexRef = useRef<ThreadIndexSnapshot | undefined>(cachedBootstrap?.threadIndex);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  snapshotRef.current = snapshot;
  const toolAnchorRef = useRef<string | undefined>(undefined);
  toolAnchorRef.current = toolAnchorId;
  const assistantStartsRef = useRef(new Map<string, number>());
  const pendingDeltasRef = useRef(new Map<string, { text: string; thinking: string }>());
  const deltaFrameRef = useRef<number | undefined>(undefined);
  const pendingToolUpdatesRef = useRef(new Map<string, string>());
  const toolFrameRef = useRef<number | undefined>(undefined);
  const runningThreadRef = useRef<string>("");
  const activeDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
  useEffect(() => {
    const reconciled = reconcileOptimisticMessages(optimisticMessages, messages);
    if (reconciled.length === optimisticMessages.length) return;
    if (pendingNewThread && reconciled.every((entry) => entry.scope !== activeDraftKey)) {
      writeNewThreadDraft(window.localStorage);
      setPendingNewThread(undefined);
    }
    setOptimisticMessages(reconciled);
  }, [activeDraftKey, messages, optimisticMessages, pendingNewThread]);

  const flushAssistantDeltas = useCallback(() => {
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    const pending = pendingDeltasRef.current;
    if (pending.size === 0) return;
    pendingDeltasRef.current = new Map();
    setMessages((current) => current.map((message) => {
      const delta = pending.get(message.id);
      if (!delta) return message;
      return {
        ...message,
        text: message.text + delta.text,
        thinking: delta.thinking ? (message.thinking ?? "") + delta.thinking : message.thinking,
      };
    }));
  }, []);

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
    setTools((current) => current.map((tool) => {
      const output = pending.get(tool.id);
      return output === undefined || output === tool.output ? tool : { ...tool, output };
    }));
  }, []);

  const queueToolUpdate = useCallback((id: string, output: string) => {
    pendingToolUpdatesRef.current.set(id, output);
    if (toolFrameRef.current === undefined) toolFrameRef.current = requestAnimationFrame(flushToolUpdates);
  }, [flushToolUpdates]);

  const applySnapshot = useCallback((next: HostSnapshot) => {
    transcriptLoadRef.current += 1;
    loadingOlderRef.current = false;
    transcriptPrependRef.current = undefined;
    pendingSessionRef.current = { switching: false };
    activeSessionRef.current = next.sessionId;
    bootstrappedRef.current = true;
    assistantStartsRef.current.clear();
    pendingDeltasRef.current.clear();
    pendingToolUpdatesRef.current.clear();
    if (toolFrameRef.current !== undefined) cancelAnimationFrame(toolFrameRef.current);
    toolFrameRef.current = undefined;
    if (deltaFrameRef.current !== undefined) cancelAnimationFrame(deltaFrameRef.current);
    deltaFrameRef.current = undefined;
    const detail: import("../shared/host-protocol").ThreadDetail = {
      sessionId: next.sessionId,
      messages: next.messages,
      isStreaming: next.isStreaming,
      activeTools: next.activeTools,
      turnActivity: next.turnActivity,
      taskProgress: next.taskProgress,
      taskHistory: next.taskHistory,
      contextUsage: next.contextUsage,
      olderCursor: next.olderCursor,
      hasMore: next.olderCursor !== undefined,
    };
    detailStoreRef.current.set(detail);
    setOlderCursor(detail.olderCursor);
    setLoadingOlder(false);
    setHistoryStatus(undefined);
    threadStore.applyHostSnapshot(next);
    threadStore.setThreadRunning(next.sessionId, next.isStreaming);
    const cachedActivity = readCachedTurnActivity(window.localStorage, next.sessionId);
    setSnapshot(next);
    setMessages(next.messages);
    const restoredActivity = next.turnActivity ?? cachedActivity;
    setTools(restoredActivity?.tools ?? []);
    setToolAnchorId(restoredActivity?.anchorMessageId);
    setTurnBaseline(cachedActivity?.baseline);
    setTurnActivitySessionId(restoredActivity ? next.sessionId : undefined);
    cachedSnapshotRef.current = next;
    activeWorkspaceRef.current = next.cwd;
    writeBootstrapCache(next, cachedIndexRef.current);
  }, [threadStore]);

  const applyThreadIndex = useCallback((threadIndex: ThreadIndexSnapshot) => {
    threadStore.applyThreadIndex(threadIndex);
    cachedIndexRef.current = threadIndex;
    writeBootstrapCache(cachedSnapshotRef.current, threadIndex);
  }, [threadStore]);

  const applyHostUpdate = useCallback((update: HostUpdate) => {
    if (update.version !== 1) return;
    if (update.type === "thread-index") {
      applyThreadIndex(update.index);
      return;
    }
    if (update.type === "thread-shell") {
      const shell = update.update.shell;
      threadStore.applyThreadShell(update.update.sessionId, shell, update.update.removed);
      if (shell) setSnapshot((current) => current && current.sessionId === shell.id ? { ...current, sessionTitle: shell.title, branch: shell.branch } : current);
      return;
    }
    if (update.type === "thread-detail") {
      const detail = update.detail;
      const pending = pendingSessionRef.current;
      if (bootstrappedRef.current && pending.switching && pending.sessionId && pending.sessionId !== detail.sessionId) return;
      if (bootstrappedRef.current && !pending.switching && activeSessionRef.current && activeSessionRef.current !== detail.sessionId) return;
      const previous = detailStoreRef.current.get(detail.sessionId);
      const sessionChanged = previous?.sessionId !== detail.sessionId;
      const keepHistory = retainsLoadedHistory(previous, detail);
      const messagesForRender = keepHistory
        ? mergeTranscriptMessages(previous.messages, detail.messages)
        : detail.messages;
      const taskHistoryForRender = keepHistory
        ? mergeTaskHistory(previous.taskHistory, detail.taskHistory)
        : detail.taskHistory;
      const detailForRender: ThreadDetail = {
        ...detail,
        messages: messagesForRender,
        taskHistory: taskHistoryForRender,
        olderCursor: keepHistory ? previous.olderCursor : detail.olderCursor,
        hasMore: keepHistory ? previous.hasMore : detail.hasMore,
      };
      transcriptLoadRef.current += 1;
      loadingOlderRef.current = false;
      transcriptPrependRef.current = undefined;
      activeSessionRef.current = detail.sessionId;
      pendingSessionRef.current = { switching: false };
      bootstrappedRef.current = true;
      detailStoreRef.current.set(detailForRender);
      threadStore.setActiveThread(detail.sessionId, detail.isStreaming);
      threadStore.setThreadRunning(detail.sessionId, detail.isStreaming);
      setOlderCursor(detailForRender.olderCursor);
      setLoadingOlder(false);
      if (!keepHistory && sessionChanged) setHistoryStatus(undefined);
      setMessages(messagesForRender);
      const cachedActivity = readCachedTurnActivity(window.localStorage, detail.sessionId);
      const restoredActivity = detail.turnActivity ?? cachedActivity;
      setTools(restoredActivity?.tools ?? []);
      setToolAnchorId(restoredActivity?.anchorMessageId);
      setTurnBaseline(cachedActivity?.baseline);
      setTurnActivitySessionId(restoredActivity ? detail.sessionId : undefined);
      setSnapshot((current) => {
        if (!current) return current;
        const shell = threadStore.getThread(detail.sessionId);
        const next = {
          ...current,
          sessionId: detail.sessionId,
          sessionTitle: shell?.title ?? current.sessionTitle,
          messages: messagesForRender,
          olderCursor: detailForRender.olderCursor,
          isStreaming: detail.isStreaming,
          activeTools: detail.activeTools,
          turnActivity: detail.turnActivity,
          taskProgress: detail.taskProgress,
          taskHistory: taskHistoryForRender,
          contextUsage: detail.contextUsage,
        };
        cachedSnapshotRef.current = next;
        writeBootstrapCache(next, cachedIndexRef.current);
        return next;
      });
      return;
    }
    if (update.type === "transcript-page") {
      const page = update.page;
      if (pendingSessionRef.current.switching || activeSessionRef.current !== page.sessionId) return;
      const currentDetail = detailStoreRef.current.get(page.sessionId);
      const currentMessages = mergeTranscriptMessages(currentDetail?.messages ?? [], messagesRef.current);
      const messagesForRender = mergeTranscriptMessages(currentMessages, page.messages, "prepend");
      const taskHistoryForRender = mergeTaskHistory(currentDetail?.taskHistory, page.taskHistory);
      if (currentDetail) {
        detailStoreRef.current.set({
          ...currentDetail,
          messages: messagesForRender,
          taskHistory: taskHistoryForRender,
          olderCursor: page.olderCursor,
          hasMore: page.hasMore,
        });
      }
      setOlderCursor(page.olderCursor);
      setMessages(messagesForRender);
      setSnapshot((current) => {
        if (!current || current.sessionId !== page.sessionId) return current;
        const next = { ...current, messages: messagesForRender, taskHistory: taskHistoryForRender, olderCursor: page.olderCursor };
        cachedSnapshotRef.current = next;
        writeBootstrapCache(next, cachedIndexRef.current);
        return next;
      });
      return;
    }
    if (update.type === "catalog") {
      setSnapshot((current) => current ? { ...current, ...update.catalog } : current);
      return;
    }
    if (update.type === "project") {
      activeWorkspaceRef.current = update.project.cwd;
      setSnapshot((current) => current ? { ...current, ...update.project } : current);
      return;
    }
    if (update.type === "run" && update.sessionId === threadStore.getSnapshot().activeThreadId) {
      threadStore.setStreaming(update.event === "started");
    }
    if (update.type === "error") setNotice(update.message);
  }, [applyThreadIndex, threadStore]);

  const applyActionResult = useCallback((result: import("../shared/host-protocol").HostActionResult) => {
    const detail = result.updates.find((update) => update.type === "thread-detail");
    if (detail?.type === "thread-detail") {
      pendingSessionRef.current = { switching: true, sessionId: detail.detail.sessionId };
    }
    result.updates.forEach((update) => applyHostUpdate(update));
  }, [applyHostUpdate]);

  const addEvent = useCallback((label: string, detail?: string, timestamp = Date.now()) => {
    setEvents((current) => [...current.slice(-99), { id: `${timestamp}-${Math.random()}`, label, detail, timestamp }]);
  }, []);
  noticeRef.current = setNotice;
  eventRef.current = addEvent;

  const workspaceCwd = safeMode ? undefined : snapshot?.cwd;
  useEffect(() => {
    if (!workspaceCwd || !window.tau) return;
    void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(String(error)));
  }, [runtimeExtensions, workspaceCwd]);

  const refreshChanges = useCallback(async () => {
    if (!window.tau) return;
    const request = ++changesRequestRef.current;
    const cwd = activeWorkspaceRef.current;
    try {
      const next = await window.tau.getChanges();
      if (request === changesRequestRef.current && cwd === activeWorkspaceRef.current) setChanges(next);
    } catch (error) {
      if (request === changesRequestRef.current) setNotice(String(error));
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    if (!window.tau) return;
    const request = ++workspaceRequestRef.current;
    const cwd = activeWorkspaceRef.current;
    try {
      const next = await window.tau.getWorkspaceInfo();
      if (request === workspaceRequestRef.current && cwd === activeWorkspaceRef.current) setWorkspace(next);
    } catch (error) {
      if (request === workspaceRequestRef.current) setNotice(String(error));
    }
  }, []);

  useEffect(() => {
    if (!workspaceCwd || !window.tau) return;
    void refreshChanges();
    void refreshWorkspace();
  }, [refreshChanges, refreshWorkspace, workspaceCwd]);

  const handleHostEvent = useCallback((event: HostEvent) => {
    // A real user message starts new work even when its thread is off-screen.
    // Recovered run status alone must not undo an explicit settled choice.
    if (event.type === "user-message") preferences.unsettle(event.sessionId);
    // Every thread streams from its own runtime. Transcript and tool events for a
    // thread that is not on screen are dropped here; its persisted state is
    // re-read when it is opened.
    if (
      (event.type === "assistant-start" || event.type === "assistant-delta" || event.type === "assistant-thinking"
        || event.type === "assistant-end" || event.type === "user-message" || event.type === "tool-start" || event.type === "tool-update"
        || event.type === "tool-end" || event.type === "queue")
      && event.sessionId !== threadStore.getSnapshot().activeThreadId
    ) return;
    switch (event.type) {
      case "host-update": applyHostUpdate(event.update); break;
      case "thread-index": applyThreadIndex(event.threadIndex); break;
      case "agent-status": {
        // Record the run against its own thread first: a thread keeps its
        // WORKING state while you are reading a different one.
        threadStore.setThreadRunning(event.sessionId, event.running);
        if (event.sessionId !== threadStore.getSnapshot().activeThreadId) break;
        if (event.running) {
          pendingToolUpdatesRef.current.clear();
          if (toolFrameRef.current !== undefined) cancelAnimationFrame(toolFrameRef.current);
          toolFrameRef.current = undefined;
          setTools([]);
          setToolAnchorId(undefined);
          setTurnBaseline(changesRef.current);
          setTurnActivitySessionId(event.sessionId);
        }
        threadStore.setStreaming(event.running);
        setSnapshot((current) => {
          if (event.running && current) runningThreadRef.current = current.sessionId;
          return current ? { ...current, isStreaming: event.running } : current;
        });
        setRunStartedAt(event.running ? Date.now() : undefined);
        if (!event.running) {
          // A reconnect can miss a final tool-end frame. Pi settling is authoritative:
          // no tool may remain running after this point.
          setTools((current) => current.map((tool) => tool.status === "running"
            ? { ...tool, status: "done", endedAt: Date.now() }
            : tool));
          // "Ready" is an unread badge: only raise it if the user was not watching this finish.
          const finished = runningThreadRef.current;
          const viewed = threadStore.getSnapshot().activeThreadId;
          if (finished && (finished !== viewed || document.hidden)) threadStore.markUnread(finished);
          runningThreadRef.current = "";
          void refreshChanges();
        }
        break;
      }
      case "assistant-start":
        // Tool-only assistant messages are common. Keep their timestamp off-screen
        // until a visible text token arrives so virtualization never estimates a
        // temporary empty row and shifts the transcript.
        assistantStartsRef.current.set(event.id, event.timestamp);
        break;
      case "assistant-delta":
        setMessages((current) => current.some((message) => message.id === event.id)
          ? current
          : [...current, {
            id: event.id,
            role: "assistant",
            text: "",
            timestamp: assistantStartsRef.current.get(event.id) ?? Date.now(),
          }]);
        queueAssistantDelta(event.id, "text", event.delta);
        break;
      case "assistant-thinking":
        // Pi presents this phase as working state rather than transcript content.
        break;
      case "assistant-end":
        flushAssistantDeltas();
        assistantStartsRef.current.delete(event.message.id);
        setMessages((current) => {
          const exists = current.some((message) => message.id === event.message.id);
          if (!event.message.text) return exists
            ? current.filter((message) => message.id !== event.message.id)
            : current;
          return exists
            ? current.map((message) => message.id === event.message.id ? event.message : message)
            : [...current, event.message];
        });
        break;
      case "user-message":
        setMessages((current) => current.some((message) => message.id === event.message.id)
          ? current.map((message) => message.id === event.message.id ? event.message : message)
          : [...current, event.message]);
        setOptimisticMessages((current) => reconcileOptimisticMessages(current, [event.message]));
        break;
      case "tool-start": {
        threadStore.toolStarted(event.tool.id, event.tool.name);
        if (!toolAnchorRef.current) {
          const anchor = [...messagesRef.current].reverse().find((message) => message.text.trim())?.id;
          toolAnchorRef.current = anchor;
          setToolAnchorId(anchor);
        }
        setTools((current) => [...current.filter((tool) => tool.id !== event.tool.id), event.tool]);
        break;
      }
      case "tool-update":
        queueToolUpdate(event.id, event.output);
        break;
      case "tool-end":
        pendingToolUpdatesRef.current.delete(event.tool.id);
        threadStore.toolEnded(event.tool.id);
        setTools((current) => current.map((tool) => tool.id === event.tool.id ? event.tool : tool));
        if (event.tool.name === "edit" || event.tool.name === "write") void refreshChanges();
        break;
      case "event-log": addEvent(event.label, event.detail, event.timestamp); break;
      case "error": setNotice(event.message); break;
      case "tool-approval":
        setApprovals((current) => [...current, event.request]);
        break;
      case "extension-ui-prompt": {
        const questionnaire = event.prompt.questionnaire;
        if (questionnaire) {
          const sessionId = event.prompt.sessionId;
          const key = questionKey(sessionId, questionnaire.index);
          const pick = questionnaire.index === 0 ? undefined : questionnaireChoicesRef.current[key];
          if (questionnaire.index === 0) {
            // A fresh questionnaire: picks left from an earlier one in this thread are stale.
            setQuestionnaireChoices((current) => Object.fromEntries(
              Object.entries(current).filter(([entry]) => !entry.startsWith(`${sessionId}:`)),
            ));
          }
          const question = questionnaire.questions[questionnaire.index];
          const value = !pick || pick.answered || pick.labels.length === 0
            ? undefined
            : event.prompt.kind === "select"
              ? optionForLabel(event.prompt.options, pick.labels[0])
              : event.prompt.kind === "input" && question?.multiSelect
                ? multiSelectValue(question, pick.labels)
                : undefined;
          if (value) {
            void window.tau?.answerExtensionUi(event.prompt.id, { value });
            setQuestionnaireChoices((current) => ({ ...current, [key]: { labels: pick!.labels, answered: true } }));
            break;
          }
        }
        setUiPrompts((current) => [...current, event.prompt]);
        break;
      }
      case "extension-ui-resolved":
        setUiPrompts((current) => current.filter((entry) => entry.id !== event.id));
        break;
      case "notice":
        setNotice(event.message);
        break;
      case "queue":
        setQueue([...event.steering, ...event.followUp]);
        addEvent("queue.changed", `${event.steering.length} steering · ${event.followUp.length} follow-up`);
        break;
    }
  }, [addEvent, applyHostUpdate, applyThreadIndex, flushAssistantDeltas, queueAssistantDelta, queueToolUpdate, refreshChanges, threadStore]);

  useEffect(() => {
    let unsubscribe = () => {};
    if (window.tau) {
      unsubscribe = window.tau.onHostEvent(handleHostEvent);
      // A question raised while nobody was listening would otherwise stall the
      // host forever, including during bootstrap itself.
      void window.tau.syncExtensionUi?.().catch(() => undefined);
      window.tau.bootstrap().then((bootstrap) => {
        applyThreadIndex(bootstrap.threadIndex);
        const current: HostSnapshot = {
          cwd: bootstrap.project.cwd,
          branch: bootstrap.project.branch,
          sessionId: bootstrap.detail.sessionId,
          sessionTitle: bootstrap.threadIndex.sessions.find((thread) => thread.id === bootstrap.detail.sessionId)?.title ?? "Untitled thread",
          models: bootstrap.catalog.models,
          model: bootstrap.catalog.model,
          thinkingLevel: bootstrap.catalog.thinkingLevel,
          thinkingLevels: bootstrap.catalog.thinkingLevels,
          serviceTier: bootstrap.catalog.serviceTier,
          serviceTierAvailable: bootstrap.catalog.serviceTierAvailable,
          allTools: bootstrap.catalog.allTools,
          composerCommands: bootstrap.catalog.composerCommands ?? [],
          extensionCount: bootstrap.catalog.extensionCount,
          messages: bootstrap.detail.messages,
          isStreaming: bootstrap.detail.isStreaming,
          activeTools: bootstrap.detail.activeTools,
          turnActivity: bootstrap.detail.turnActivity,
          taskProgress: bootstrap.detail.taskProgress,
          taskHistory: bootstrap.detail.taskHistory,
          contextUsage: bootstrap.detail.contextUsage,
          olderCursor: bootstrap.detail.olderCursor,
        };
        applySnapshot(current);
        void refreshChanges();
        void refreshWorkspace();
      }).catch((error) => setNotice(String(error)));
      window.tau.listEditors().then(setEditors).catch(() => setEditors([]));
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, handleHostEvent, refreshChanges, refreshWorkspace]);

  // Best-effort sync: while Pi owns the runtime the access gate lives there, so a
  // refusal is expected on attach and must not surface as an error on every launch.
  const accessSyncedRef = useRef<AccessLevel | undefined>(undefined);
  useEffect(() => {
    const previous = accessSyncedRef.current;
    accessSyncedRef.current = settings.accessLevel;
    void window.tau?.setAccessLevel(settings.accessLevel).then((result) => {
      // Only speak up when the user actually changed it, not on the initial push.
      if (result?.applied !== false) return;
      if (previous === undefined || previous === settings.accessLevel) return;
      setNotice(result.reason ?? "Access level could not be applied.");
    }).catch(() => undefined);
  }, [settings.accessLevel]);

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

  useTailScroll(transcriptRef, [messages, tools, changes, turnBaseline], snapshot?.sessionId, transcriptPrependRef);

  const loadOlder = useCallback(async () => {
    const sessionId = snapshot?.sessionId;
    const cursor = olderCursor;
    if (!cursor || !sessionId || !window.tau || loadingOlderRef.current) return;
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const request = ++transcriptLoadRef.current;
    loadingOlderRef.current = true;
    transcriptPrependRef.current = true;
    const previousScrollTop = transcript.scrollTop;
    setLoadingOlder(true);
    setHistoryStatus(undefined);
    const previousHeight = transcript.scrollHeight;
    let restoreScheduled = false;
    const finishLoading = () => {
      if (request !== transcriptLoadRef.current) return;
      loadingOlderRef.current = false;
      transcriptPrependRef.current = undefined;
      setLoadingOlder(false);
    };
    try {
      const page = await window.tau.loadTranscript(sessionId, cursor);
      if (
        request !== transcriptLoadRef.current
        || pendingSessionRef.current.switching
        || activeSessionRef.current !== sessionId
        || snapshotRef.current?.sessionId !== sessionId
        || page.sessionId !== sessionId
      ) return;
      const currentDetail = detailStoreRef.current.get(sessionId);
      const currentMessages = mergeTranscriptMessages(currentDetail?.messages ?? [], messagesRef.current);
      const messagesForRender = mergeTranscriptMessages(currentMessages, page.messages, "prepend");
      const taskHistoryForRender = mergeTaskHistory(currentDetail?.taskHistory, page.taskHistory);
      if (currentDetail) {
        detailStoreRef.current.set({
          ...currentDetail,
          messages: messagesForRender,
          taskHistory: taskHistoryForRender,
          olderCursor: page.olderCursor,
          hasMore: page.hasMore,
        });
      }
      setMessages(messagesForRender);
      setOlderCursor(page.olderCursor);
      setSnapshot((current) => {
        if (!current || current.sessionId !== sessionId) return current;
        const next = { ...current, messages: messagesForRender, taskHistory: taskHistoryForRender, olderCursor: page.olderCursor };
        cachedSnapshotRef.current = next;
        writeBootstrapCache(next, cachedIndexRef.current);
        return next;
      });
      const loadedTurns = countUserTurns(page.messages);
      setHistoryStatus({ state: "success", loadedTurns });
      restoreScheduled = true;
      const restore = (framesRemaining: number) => {
        if (request !== transcriptLoadRef.current || activeSessionRef.current !== sessionId || pendingSessionRef.current.switching) {
          finishLoading();
          return;
        }
        const current = transcriptRef.current;
        if (current) restoreTranscriptScrollPosition(current, previousHeight, previousScrollTop);
        if (framesRemaining > 0) {
          window.requestAnimationFrame(() => restore(framesRemaining - 1));
        } else {
          finishLoading();
        }
      };
      window.requestAnimationFrame(() => restore(2));
    } catch (error) {
      if (request === transcriptLoadRef.current && activeSessionRef.current === sessionId) {
        const message = error instanceof Error ? error.message : String(error);
        setHistoryStatus({ state: "error", message: `Could not load older turns: ${message}` });
      }
    } finally {
      if (!restoreScheduled) finishLoading();
    }
  }, [olderCursor, snapshot]);

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

  const refreshFiles = useCallback(async () => {
    if (window.tau) setFileTree((await window.tau.getFileTree()) ?? []);
    else setFileTree([
      { name: "src", path: "/workspace/tau/src", kind: "directory", children: [
        { name: "renderer", path: "/workspace/tau/src/renderer", kind: "directory", children: [
          { name: "thread-store.ts", path: "/workspace/tau/src/renderer/thread-store.ts", kind: "file" },
          { name: "App.tsx", path: "/workspace/tau/src/renderer/App.tsx", kind: "file" },
          { name: "extension-system.tsx", path: "/workspace/tau/src/renderer/extension-system.tsx", kind: "file" },
        ] },
      ] },
      { name: "README.md", path: "/workspace/tau/README.md", kind: "file" },
    ]);
  }, []);

  const loadFiles = useCallback(async (path: string): Promise<FileNode[]> => {
    const children = window.tau ? ((await window.tau.getFileTree(path)) ?? []) : [];
    setFileTree((current) => {
      const attach = (nodes: FileNode[]): FileNode[] => nodes.map((node) => node.path === path
        ? { ...node, children }
        : node.children ? { ...node, children: attach(node.children) } : node);
      return attach(current);
    });
    return children;
  }, []);

  const openPanel = useCallback((id: string) => {
    setActivePanel(id);
    setOpenedPanels((current) => current.has(id) ? current : new Set(current).add(id));
    setDockOpen(true);
  }, []);
  const openReview = useCallback((path?: string, primaryPush = Boolean(workspace?.upstream)) => {
    void refreshChanges();
    setReview({ path, primaryPush });
  }, [refreshChanges, workspace?.upstream]);

  const acceptWorkspace = useCallback((result: HostActionResult) => {
    const cwd = result.updates.find((update) => update.type === "project")?.project.cwd;
    applyActionResult(result);
    if (cwd && cwd !== snapshot?.cwd) {
      setFileTree([]);
      setChanges(NO_CHANGES);
    }
    void refreshChanges();
    void refreshWorkspace();
  }, [applyActionResult, refreshChanges, refreshWorkspace, snapshot?.cwd]);

  const requireHost = useCallback((what: string): boolean => {
    if (window.tau) return true;
    setNotice(`${what} requires the Electron host`);
    return false;
  }, []);

  const chooseWorkspace = useCallback(async (): Promise<boolean> => {
    if (!requireHost("Project selection")) return false;
    try {
      const next = await window.tau!.chooseWorkspace();
      if (!next) return false;
      acceptWorkspace(next);
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost]);

  const openWorkspace = useCallback(async (path: string): Promise<boolean> => {
    if (path === snapshot?.cwd) return true;
    if (!requireHost("Project switching")) return false;
    try {
      acceptWorkspace(await window.tau!.openProject(path));
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost, snapshot?.cwd]);

  const removeProject = useCallback(async (project: UiProject) => {
    if (!requireHost("Project removal")) return;
    try {
      applyActionResult(await window.tau!.removeProject(project.path));
    } catch (error) {
      setNotice(String(error));
    }
  }, [applyActionResult, requireHost]);

  const createThreadInProject = useCallback((project: UiProject) => {
    const draft = { projectPath: project.path, projectName: project.name };
    writeNewThreadDraft(window.localStorage, draft);
    setPendingNewThread(draft);
    setNewThreadOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const browseForNewThread = useCallback(async () => {
    setNewThreadOpen(false);
    await chooseWorkspace();
  }, [chooseWorkspace]);

  const cloneWorkspace = useCallback(async (repositoryUrl: string): Promise<boolean> => {
    if (!requireHost("Git clone")) return false;
    try {
      const next = await window.tau!.cloneProject(repositoryUrl);
      if (!next) return false;
      acceptWorkspace(next);
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [acceptWorkspace, requireHost]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    setPendingNewThread(undefined);
    writeNewThreadDraft(window.localStorage);
    const startedAt = performance.now();
    const previous = snapshot;
    const target = threadStore.getSnapshot().threads.find((session) => session.path === path);
    transcriptLoadRef.current += 1;
    loadingOlderRef.current = false;
    transcriptPrependRef.current = undefined;
    pendingSessionRef.current = { switching: true, sessionId: target?.id };
    setLoadingOlder(false);
    setHistoryStatus(undefined);
    const cached = target ? detailStoreRef.current.get(target.id) : undefined;
    if (cached && snapshot && target) {
      applySnapshot(optimisticThreadSnapshot(snapshot, target, cached));
      addEvent("thread.switch.cached", target?.title);
    }
    try {
      const next = await window.tau!.switchSession(path);
      applyActionResult(next);
      threadStore.markRead(target?.id ?? "");
      addEvent("thread.switch.confirmed", `${Math.round(performance.now() - startedAt)}ms`);
      return true;
    } catch (error) {
      if (previous) applySnapshot(previous);
      setNotice(String(error));
      return false;
    }
  }, [addEvent, applyActionResult, applySnapshot, requireHost, snapshot, threadStore]);

  const renameThread = useCallback(async (title: string): Promise<boolean> => {
    if (!requireHost("Thread rename")) return false;
    try {
      applyActionResult(await window.tau!.renameThread(
        title,
        threadStore.getSnapshot().activeThreadId,
      ));
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [applyActionResult, requireHost, threadStore]);

  const generateThreadTitle = useCallback(async (provider: string, modelId: string, force = false): Promise<boolean> => {
    if (!requireHost("Title generation")) return false;
    try {
      applyActionResult(await window.tau!.generateThreadTitle(
        provider,
        modelId,
        force,
        threadStore.getSnapshot().activeThreadId,
      ));
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    }
  }, [applyActionResult, requireHost, threadStore]);

  const setModel = useCallback(async (provider: string, id: string) => {
    if (!requireHost("Model selection")) return;
    try {
      applyActionResult(await window.tau!.setModel(provider, id));
    } catch (error) {
      setNotice(String(error));
    }
  }, [applyActionResult, requireHost]);

  const setThinking = useCallback(async (level: string) => {
    if (!requireHost("Thinking level")) return;
    try {
      applyActionResult(await window.tau!.setThinkingLevel(level));
    } catch (error) {
      setNotice(String(error));
    }
  }, [applyActionResult, requireHost]);

  const setServiceTier = useCallback(async (tier: ServiceTier) => {
    if (!requireHost("Service tier")) return;
    try {
      applyActionResult(await window.tau!.setServiceTier(tier));
    } catch (error) {
      setNotice(String(error));
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
      setTools([]);
      setToolAnchorId(undefined);
      setNotice("Closed the interrupted call. The thread can continue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  const compactContext = useCallback(async () => {
    if (!requireHost("Compaction")) return;
    try {
      applyActionResult(await window.tau!.compactContext());
      setNotice("Context compacted.");
    } catch (error) {
      setNotice(String(error));
    }
  }, [applyActionResult, requireHost]);

  const openInEditor = useCallback(async (path?: string, editorOverride?: string) => {
    const editorId = editorOverride ?? settings.editorId ?? editors[0]?.id;
    if (!editorId) { setNotice("No supported editor found on PATH"); return; }
    if (!requireHost("Opening an editor")) return;
    try {
      await window.tau!.openInEditor(editorId, path);
    } catch (error) {
      setNotice(String(error));
    }
  }, [editors, requireHost, settings.editorId]);

  const commit = useCallback(async (message: string, push: boolean) => {
    if (!requireHost("Committing")) return;
    setCommitting(true);
    try {
      const result = await window.tau!.commit(message, push);
      setChanges(result.changes);
      setNotice(result.detail);
      addEvent("git.commit", result.detail);
      void refreshWorkspace();
      if (result.changes.files.length === 0) setReview(undefined);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setCommitting(false);
    }
  }, [addEvent, refreshWorkspace, requireHost]);

  const pushWorkspace = useCallback(async () => {
    if (!requireHost("Pushing")) return;
    setCommitting(true);
    try {
      const result = await window.tau!.push();
      setNotice(result.detail);
      addEvent("git.push", result.detail);
      await Promise.all([refreshChanges(), refreshWorkspace()]);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setCommitting(false);
    }
  }, [addEvent, refreshChanges, refreshWorkspace, requireHost]);

  const runShellAction = useCallback(async (command: string, includeInContext: boolean, name: string) => {
    if (!requireHost("Project actions")) return;
    try {
      setNotice(`Running ${name}…`);
      const result = await window.tau!.runShellAction(command, includeInContext, snapshot?.cwd);
      const tail = result.output.trim().split("\n").at(-1);
      setNotice(result.exitCode === 0 ? `${name} finished${tail ? ` · ${tail}` : ""}` : `${name} failed${tail ? ` · ${tail}` : ""}`);
      await Promise.all([refreshChanges(), refreshWorkspace()]);
    } catch (error) {
      setNotice(String(error));
    }
  }, [refreshChanges, refreshWorkspace, requireHost, snapshot?.cwd]);

  const runWorkspaceAction = useCallback(async (action: () => Promise<HostActionResult>): Promise<boolean> => {
    if (!requireHost("Worktrees")) return false;
    setWorkspaceBusy(true);
    try {
      const result = await action();
      const pendingDraft = composerRef.current?.value ?? "";
      acceptWorkspace(result);
      const detail = result.updates.find((update) => update.type === "thread-detail");
      if (pendingDraft && detail?.type === "thread-detail") {
        writeComposerDraft(window.localStorage, draftKey(detail.detail.sessionId), pendingDraft);
        setComposerSeed(pendingDraft);
      }
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setWorkspaceBusy(false);
    }
  }, [acceptWorkspace, requireHost]);

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
    if (prompt?.questionnaire && "value" in answer) {
      const question = prompt.questionnaire.questions[prompt.questionnaire.index];
      // Multi-select answers are option numbers; keep the labels for the page summary.
      const labels = answer.typed
        ? [answer.value]
        : prompt.kind === "input" && question?.multiSelect
          ? answer.value.split(/[,\s]+/u).flatMap((token) => {
            const option = question.options[Number(token) - 1];
            return option ? [option.label] : [];
          })
          : [splitOption(answer.value).label];
      const key = questionKey(prompt.sessionId, prompt.questionnaire.index);
      setQuestionnaireChoices((current) => ({ ...current, [key]: { labels: labels.length > 0 ? labels : [answer.value], answered: true } }));
    }
    setUiPrompts((current) => current.filter((entry) => entry.id !== id));
    void window.tau?.answerExtensionUi(id, answer);
  }, []);

  const preselectQuestion = useCallback((index: number, labels: string[]) => {
    const active = threadPrompts[0];
    if (!active) return;
    setQuestionnaireChoices((current) => ({ ...current, [questionKey(active.sessionId, index)]: { labels, answered: false } }));
  }, [threadPrompts]);

  const promptChoices = useMemo(() => {
    const active = threadPrompts[0];
    if (!active?.questionnaire) return undefined;
    const choices: Record<number, QuestionnaireChoice> = {};
    active.questionnaire.questions.forEach((_question, index) => {
      const pick = questionnaireChoices[questionKey(active.sessionId, index)];
      if (pick) choices[index] = pick;
    });
    return choices;
  }, [questionnaireChoices, threadPrompts]);

  const resolveApproval = useCallback((id: string, allowed: boolean) => {
    setApprovals((current) => current.filter((request) => request.id !== id));
    void window.tau?.resolveToolApproval(id, allowed);
  }, []);

  const settleActiveThread = useCallback(() => {
    const activeId = threadStore.getSnapshot().activeThreadId;
    if (!activeId) return;
    preferences.toggleSettled(activeId);
  }, [threadStore]);

  const copyThreadValue = useCallback(async (kind: "chat" | "path" | "branch" | "thread-id") => {
    if (kind === "chat") {
      if (!snapshot?.sessionId || !window.tau) return;
      try {
        await window.tau.copyThreadMarkdown(snapshot.sessionId);
        setNotice("Chat copied as Markdown.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const value = kind === "path"
      ? snapshot?.cwd
      : kind === "branch"
        ? snapshot?.branch
        : snapshot?.sessionId;
    if (!value) {
      setNotice(`${kind === "branch" ? "Branch" : "Value"} is unavailable.`);
      return;
    }
    try {
      await window.tau?.copyText(value);
      setNotice(`${kind === "path" ? "Path" : kind === "branch" ? "Branch" : "Thread ID"} copied.`);
    } catch (error) {
      setNotice(String(error));
    }
  }, [snapshot?.branch, snapshot?.cwd, snapshot?.sessionId]);

  const copyMessage = useCallback(async (message: UiMessage) => {
    try {
      await window.tau?.copyText(message.text);
      setNotice("Message copied.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const forkMessage = useCallback(async (message: UiMessage) => {
    if (!message.sourceEntryId || !snapshot?.sessionId || !requireHost("Fork thread")) return;
    try {
      setNotice("Forking thread…");
      applyActionResult(await window.tau!.forkThread(message.sourceEntryId, snapshot.sessionId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  const rebuildWorkbench = useCallback(async () => {
    if (!requireHost("Rebuilding")) return false;
    setNotice("Rebuilding Tau from source…");
    try {
      const result = await window.tau!.rebuildWorkbench();
      if (!result.ok) {
        addEvent("workbench.build.failed", result.output);
        setNotice(`Build failed: ${result.output.split("\n").filter(Boolean).at(-1) ?? "see Signals"}`);
        return false;
      }
      if (result.mainChanged) {
        setNotice(`Rebuilt in ${Math.round(result.durationMs / 100) / 10}s. The host changed too — run /restart to apply it.`);
        return true;
      }
      window.location.reload();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [addEvent, requireHost]);

  const restartWorkbench = useCallback(() => {
    if (!requireHost("Restarting")) return;
    void window.tau!.relaunchWorkbench();
  }, [requireHost]);

  const reloadRuntime = useCallback(async () => {
    if (!requireHost("Runtime reload")) return false;
    try {
      setNotice("Reloading Pi and desktop extensions…");
      await window.tau!.reloadRuntime();
      window.location.reload();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [requireHost]);

  const actions: WorkbenchActions = useMemo(() => ({
    openPanel,
    openCommandPalette: () => setPaletteOpen(true),
    openSettings: (page) => setSettingsPage(page ?? "defaults"),
    openReview: () => openReview(),
    newSession: () => setNewThreadOpen(true),
    switchSession,
    settleActiveThread,
    abort: () => void window.tau?.abort(threadStore.getSnapshot().activeThreadId || undefined),
    reloadRuntime,
    rebuildWorkbench,
    restartWorkbench,
    focusComposer: (seed) => { if (seed !== undefined) { setComposerSeed(seed); writeComposerDraft(window.localStorage, activeDraftKey, seed); } composerRef.current?.focus(); },
    notify: setNotice,
    chooseWorkspace,
    openWorkspace,
    cloneWorkspace,
    generateThreadTitle,
    regenerateTitle: async (force = true) => {
      const model = snapshot?.model;
      if (!model) { setNotice("No model is selected for this thread."); return false; }
      return generateThreadTitle(model.provider, model.id, force);
    },
  }), [
    chooseWorkspace, cloneWorkspace, generateThreadTitle, openPanel,
    activeDraftKey, openReview, openWorkspace, rebuildWorkbench, reloadRuntime, restartWorkbench, settleActiveThread, snapshot?.model, switchSession,
  ]);

  const submit = useCallback(async (
    value: string,
    attachments: UiPromptAttachment[] = [],
    delivery?: "followUp" | "steer",
  ) => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    if (text === "/reload" && attachments.length === 0) {
      await reloadRuntime();
      return;
    }
    if (text === "/rebuild" && attachments.length === 0) {
      await rebuildWorkbench();
      return;
    }
    if (text === "/restart" && attachments.length === 0) {
      restartWorkbench();
      return;
    }
    const optimisticText = text || `Attached ${attachments.map((attachment) => attachment.name).join(", ")}`;
    const optimistic: UiMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text: optimisticText,
      images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
      timestamp: Date.now(),
    };
    const optimisticScope = activeDraftKey ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    if (!pendingNewThread && visibleStreaming) {
      if (delivery === "steer") {
        setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
        try {
          if (!window.tau) throw new Error("Steering requires the Electron host.");
          await window.tau.steer(text, attachments, snapshot?.sessionId);
        } catch (error) {
          setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
          writeComposerDraft(window.localStorage, activeDraftKey, text);
          setComposerSeed(text);
          setNotice(String(error));
        }
      } else {
        const queuedText = optimisticText;
        setQueue((current) => [...current, queuedText]);
        try {
          if (!window.tau) throw new Error("Follow-up messages require the Electron host.");
          await window.tau.followUp(text, attachments, snapshot?.sessionId);
        } catch (error) {
          setQueue((current) => {
            const index = current.lastIndexOf(queuedText);
            return index < 0 ? current : current.filter((_, at) => at !== index);
          });
          writeComposerDraft(window.localStorage, activeDraftKey, text);
          setComposerSeed(text);
          setNotice(String(error));
        }
      }
      return;
    }
    if (pendingNewThread) {
      const pending = pendingNewThread;
      const pendingKey = draftKey(undefined, pending);
      setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      try {
        if (!window.tau) throw new Error("New thread requires the Electron host.");
        const result = await window.tau.newSession(text, attachments, pending.projectPath);
        const created = result.updates.find((update) => update.type === "thread-detail");
        const sessionId = created?.type === "thread-detail" ? created.detail.sessionId : undefined;
        if (sessionId) {
          // The optimistic message moves to the real thread before the draft
          // view closes, so nothing flickers while the host confirms it.
          setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimistic.id
            ? { ...entry, scope: `session:${sessionId}` }
            : entry));
          writeNewThreadDraft(window.localStorage);
          setPendingNewThread(undefined);
          acceptWorkspace(result);
          threadStore.markRead(sessionId);
          await registry.notifyPromptSubmitted({
            prompt: text,
            snapshot: snapshot ? {
              ...snapshot,
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
          }, actions);
        } else {
          // Pi's own TUI creates the thread and reports it later; the draft
          // view stays until that report arrives.
          applyActionResult(result);
        }
        writeComposerDraft(window.localStorage, pendingKey, "");
      } catch (error) {
        setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
        writeComposerDraft(window.localStorage, pendingKey, text);
        setComposerSeed(text);
        setNotice(String(error));
      }
      return;
    }
    if (snapshot) {
      threadStore.markRead(snapshot.sessionId);
      preferences.unsettle(snapshot.sessionId);
    }
    setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
    if (window.tau) {
      try {
        await window.tau.sendPrompt(text, attachments, snapshot?.sessionId);
        await registry.notifyPromptSubmitted({ prompt: text, snapshot }, actions);
      } catch (error) {
        setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
        writeComposerDraft(window.localStorage, activeDraftKey, text);
        setComposerSeed(text);
        setNotice(String(error));
      }
    } else {
      setSnapshot((current) => current ? { ...current, isStreaming: true } : current);
      setRunStartedAt(Date.now());
      window.setTimeout(() => {
        setMessages((current) => [...current, {
          id: `mock-${Date.now()}`,
          role: "assistant",
          text: "Preview mode received the prompt. Launch `npm start` to send it through the real Pi SDK.",
          timestamp: Date.now(),
        }]);
        setSnapshot((current) => current ? { ...current, isStreaming: false } : current);
        setRunStartedAt(undefined);
      }, 650);
    }
  }, [acceptWorkspace, actions, activeDraftKey, applyActionResult, pendingNewThread, rebuildWorkbench, registry, reloadRuntime, restartWorkbench, snapshot, threadStore, visibleStreaming]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (meta && event.key.toLowerCase() === "n") { event.preventDefault(); setNewThreadOpen(true); }
      if (meta && event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); settleActiveThread(); }
      if (meta && event.shiftKey && event.key.toLowerCase() === "d") { event.preventDefault(); openReview(); }
      if (
        event.key === "Escape" &&
        visibleStreaming &&
        !paletteOpen &&
        !document.querySelector('[aria-modal="true"]')
      ) void window.tau?.abort(threadStore.getSnapshot().activeThreadId || undefined);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [openReview, paletteOpen, settleActiveThread, threadStore, visibleStreaming]);

  useEffect(() => {
    const sessionId = snapshot?.sessionId;
    if (!sessionId || turnActivitySessionId !== sessionId || !turnBaseline) return;
    writeCachedTurnActivity(window.localStorage, {
      sessionId,
      baseline: turnBaseline,
      tools,
      anchorMessageId: toolAnchorId,
    });
  }, [snapshot?.sessionId, toolAnchorId, tools, turnActivitySessionId, turnBaseline]);

  const turnChanges = useMemo(
    () => turnBaseline ? changesSinceTurn(turnBaseline, changes) : changesTouchedByTools(tools, changes),
    [changes, tools, turnBaseline],
  );
  const activityTools = useMemo(() => tools.filter((tool) => tool.name !== "todo"), [tools]);

  const contextBreakdown: ContextBreakdown = useMemo(() => {
    const usage = snapshot?.contextUsage;
    if (!usage) return { messages: 0, toolOutput: 0, system: 0 };
    const messageTokens = messages.reduce(
      (total, message) => total + estimateTokens(message.text) + estimateTokens(message.thinking ?? ""),
      0,
    );
    const toolTokens = tools.reduce((total, tool) => total + estimateTokens(tool.output ?? ""), 0);
    const accounted = Math.min(usage.tokens, messageTokens + toolTokens);
    const scale = messageTokens + toolTokens > 0 ? accounted / (messageTokens + toolTokens) : 0;
    return {
      messages: Math.round(messageTokens * scale),
      toolOutput: Math.round(toolTokens * scale),
      system: Math.max(0, usage.tokens - accounted),
    };
  }, [messages, snapshot?.contextUsage, tools]);

  const contextValue = useMemo(
    () => ({ snapshot, tools, events, fileTree, changes, registry, refreshFiles, loadFiles, refreshChanges, openReview, applySnapshot, handleHostEvent }),
    [snapshot, tools, events, fileTree, changes, registry, refreshFiles, loadFiles, refreshChanges, openReview, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot, registry }), [snapshot, registry]);
  const panelProject = useMemo(() => snapshot ? { cwd: snapshot.cwd } : undefined, [snapshot?.cwd]);
  const filesContextValue = useMemo(() => ({ fileTree, snapshot: panelProject, refreshFiles, loadFiles }), [fileTree, panelProject, refreshFiles, loadFiles]);
  const changesContextValue = useMemo(() => ({ changes, snapshot: panelProject, refreshChanges, openReview }), [changes, panelProject, refreshChanges, openReview]);
  const observatoryContextValue = useMemo(() => ({ events, snapshot, tools, registry }), [events, snapshot, tools, registry]);
  const sidebarContributions = registry.getSidebarContributions();
  const commands = registry.getCommands();
  const activeEditor = editors.find((editor) => editor.id === settings.editorId) ?? editors[0];
  const scopedOptimisticMessages = optimisticMessages.filter((entry) => entry.scope === activeDraftKey);
  const unconfirmedOptimisticMessages = reconcileOptimisticMessages(scopedOptimisticMessages, messages).map((entry) => entry.message);
  const conversationMessages = pendingNewThread
    ? unconfirmedOptimisticMessages
    : [...messages, ...unconfirmedOptimisticMessages].sort((left, right) => left.timestamp - right.timestamp);
  const visibleToolAnchorId = visibleStreaming
    ? latestActivityAnchor(conversationMessages)
    : latestActivityAnchor(conversationMessages, toolAnchorId);
  const conversationSnapshot = pendingNewThread && snapshot ? {
    ...snapshot,
    cwd: pendingNewThread.projectPath,
    sessionId: `draft:${pendingNewThread.projectPath}`,
    sessionName: undefined,
    sessionTitle: "Untitled thread",
    isStreaming: false,
    taskProgress: undefined,
    taskHistory: [],
  } : snapshot ? { ...snapshot, isStreaming: visibleStreaming } : snapshot;
  const conversationActivityTools = pendingNewThread ? [] : activityTools;
  const conversationPrompts = pendingNewThread ? [] : threadPrompts;
  const showStartScreen = conversationMessages.length === 0
    && !conversationSnapshot?.isStreaming
    && conversationActivityTools.length === 0
    && conversationPrompts.length === 0;
  const startProjectPath = conversationSnapshot?.cwd ?? "";
  const startProjectName = pendingNewThread?.projectName
    ?? projects.find((project) => project.path === startProjectPath)?.name
    ?? startProjectPath.split(/[\\/]/u).filter(Boolean).at(-1)
    ?? startProjectPath;
  const shellClassName = [
    "app-shell",
    sidebarContributions.length === 0 ? "no-sidebar" : "",
    panels.length === 0 ? "no-dock" : "",
    dockOpen ? "" : "dock-closed",
  ].filter(Boolean).join(" ");

  const conversationComposer = (
    <Composer
      snapshot={conversationSnapshot}
      seed={composerSeed}
      draftStorageKey={activeDraftKey}
      queue={queue}
      accessLevel={settings.accessLevel}
      contextUsage={snapshot?.contextUsage}
      contextBreakdown={contextBreakdown}
      textareaRef={composerRef}
      onSubmit={(text, attachments, delivery) => void submit(text ?? "", attachments, delivery)}
      onAbort={() => void window.tau?.abort(snapshot?.sessionId)}
      onCancelQueued={(index) => setQueue((current) => current.filter((_, at) => at !== index))}
      onSetModel={(provider, id) => void setModel(provider, id)}
      onSetThinking={(level) => void setThinking(level)}
      onSetServiceTier={(tier) => void setServiceTier(tier)}
      prompt={conversationPrompts[0]}
      promptsPending={Math.max(0, conversationPrompts.length - 1)}
      onAnswerPrompt={(value, typed) => {
        const active = conversationPrompts[0];
        if (!active) return;
        answerUiPrompt(active.id, typeof value === "boolean" ? { confirmed: value } : typed ? { value, typed } : { value });
      }}
      onCancelPrompt={() => {
        const active = conversationPrompts[0];
        if (active) answerUiPrompt(active.id, { cancelled: true });
      }}
      promptChoices={promptChoices}
      onPreselectQuestion={preselectQuestion}
      onSetAccess={(level: AccessLevel) => preferences.setAccessLevel(level)}
      onCompactContext={() => void compactContext()}
      workspace={workspace}
      workspaceBusy={workspaceBusy}
      onOpenWorktree={(path) => path === snapshot?.cwd
        ? Promise.resolve(true)
        : runWorkspaceAction(() => window.tau!.openProject(path))}
      onCreateWorktree={(branch, baseRef) => runWorkspaceAction(() => window.tau!.createWorktree(branch, baseRef))}
      onSwitchRef={(ref) => runWorkspaceAction(() => window.tau!.switchRef(ref))}
    />
  );

  const overlays = (
    <>
      {approvals[0] ? (
        <ToolApproval
          request={approvals[0]}
          pending={approvals.length - 1}
          onResolve={resolveApproval}
        />
      ) : null}
      <LazyFeatureBoundary label="command palette">
        <Suspense fallback={<LazyFeatureFallback label="command palette" />}>
          <LazyCommandPalette
            open={paletteOpen}
            commands={commands}
            extensionCount={registry.getExtensionNames().length}
            actions={actions}
            onClose={() => setPaletteOpen(false)}
          />
        </Suspense>
      </LazyFeatureBoundary>
      <ProjectPicker
        open={newThreadOpen}
        projects={projects}
        onBrowse={() => void browseForNewThread()}
        onClose={() => setNewThreadOpen(false)}
        onRemove={removeProject}
        onSelect={(project) => createThreadInProject(project)}
      />
      {settingsPage ? (
        <LazyFeatureBoundary label="settings">
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
        </LazyFeatureBoundary>
      ) : null}
      {notice ? (
        <button className="toast" onClick={() => setNotice(undefined)}>
          <b>NOTICE</b><span>{notice}</span><i>×</i>
        </button>
      ) : null}
    </>
  );

  if (review) {
    return (
      <ThreadStoreContext.Provider value={threadStore}>
        <WorkbenchShellContext.Provider value={shellContextValue}>
          <WorkbenchContext.Provider value={contextValue}>
            <FilesContext.Provider value={filesContextValue}>
              <ChangesContext.Provider value={changesContextValue}>
                <ObservatoryContext.Provider value={observatoryContextValue}>
                  <LazyFeatureBoundary label="review">
                    <Suspense fallback={<LazyFeatureFallback label="review" />}>
                      <LazyReviewMode
                        changes={changes}
                        selectedPath={review.path ?? changes.files[0]?.path}
                        editor={activeEditor}
                        busy={committing}
                        primaryPush={review.primaryPush}
                        onSelect={(path) => setReview((current) => ({ path, primaryPush: current?.primaryPush ?? Boolean(workspace?.upstream) }))}
                        onBack={() => setReview(undefined)}
                        onCommit={(message, push) => void commit(message, push)}
                        onOpenInEditor={(path) => void openInEditor(path)}
                        loadDiff={async (path) => window.tau
                          ? window.tau.getFileDiff(path)
                          : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }}
                      />
                    </Suspense>
                  </LazyFeatureBoundary>
            {overlays}
              </ObservatoryContext.Provider>
              </ChangesContext.Provider>
            </FilesContext.Provider>
          </WorkbenchContext.Provider>
        </WorkbenchShellContext.Provider>
      </ThreadStoreContext.Provider>
    );
  }

  return (
    <ThreadStoreContext.Provider value={threadStore}>
      <WorkbenchShellContext.Provider value={shellContextValue}>
        <WorkbenchContext.Provider value={contextValue}>
          <FilesContext.Provider value={filesContextValue}>
            <ChangesContext.Provider value={changesContextValue}>
            <ObservatoryContext.Provider value={observatoryContextValue}>
          <div className={shellClassName}>
            <TitleBar
              cwd={snapshot?.cwd}
              editors={editors}
              activeEditor={activeEditor}
              changes={changes}
              workspace={workspace}
              gitBusy={committing}
              dockOpen={dockOpen}
              onOpenInEditor={(editorId) => void openInEditor(undefined, editorId)}
              onChooseEditor={(id) => preferences.setEditor(id)}
              onOpenReview={(push) => openReview(undefined, push)}
              onPush={() => void pushWorkspace()}
              onRunAction={(command, includeInContext, name) => void runShellAction(command, includeInContext, name)}
              onToggleDock={() => setDockOpen((value) => !value)}
            />

            {sidebarContributions.map((contribution) => (
              <LazyFeatureBoundary key={contribution.id} label="sidebar">
                <Suspense fallback={<LazyFeatureFallback label="sidebar" />}>
                  <contribution.Component actions={actions} />
                </Suspense>
              </LazyFeatureBoundary>
            ))}

            <main className={`conversation-column ${showStartScreen ? "conversation-start" : ""}`}>
              {showStartScreen ? (
                <section className="conversation-start-screen" aria-labelledby="start-screen-title">
                  <div className="conversation-start-content">
                    <h1 id="start-screen-title">What do you want to build?</h1>
                    <button
                      type="button"
                      className="conversation-start-project"
                      aria-label={`Change project, current project ${startProjectName}`}
                      onClick={() => setNewThreadOpen(true)}
                    >
                      <i><Folder size={17} /></i>
                      <span>
                        <small>Current project</small>
                        <strong>{startProjectName}</strong>
                        <code title={startProjectPath}>{displayPath(startProjectPath)}</code>
                      </span>
                      <b>Change</b>
                      <ChevronDown size={15} />
                    </button>
                    {conversationComposer}
                  </div>
                </section>
              ) : (
                <>
              <header className="conversation-header">
                <ThreadTitleMenu
                  title={conversationSnapshot?.sessionTitle || "Untitled thread"}
                  branch={snapshot?.branch}
                  pinned={Boolean(snapshot?.sessionId && settings.pinnedThreadIds.includes(snapshot.sessionId))}
                  settled={Boolean(snapshot?.sessionId && settings.settledThreadIds.includes(snapshot.sessionId))}
                  onNewThread={() => setNewThreadOpen(true)}
                  onTogglePin={() => { if (snapshot?.sessionId) preferences.togglePinned(snapshot.sessionId); }}
                  onToggleSettled={settleActiveThread}
                  onRename={renameThread}
                  onRegenerate={() => void actions.regenerateTitle(true)}
                  onMarkUnread={() => { if (snapshot?.sessionId) threadStore.markUnread(snapshot.sessionId); }}
                  onCopy={(kind) => void copyThreadValue(kind)}
                />
                <span className="title-spacer" />
              </header>

              <div className="transcript" ref={transcriptRef}>
                <div className="transcript-inner">
                  {!pendingNewThread && conversationMessages.length > 0 ? (
                    <TranscriptHistoryControl
                      olderCursor={olderCursor}
                      loading={loadingOlder}
                      status={historyStatus}
                      onLoad={() => void loadOlder()}
                    />
                  ) : null}
                  <VirtualTranscript
                    messages={conversationMessages}
                    scrollRef={transcriptRef}
                    isStreaming={Boolean(conversationSnapshot?.isStreaming)}
                    activity={conversationActivityTools.length > 0 ? (
                      <ToolGroup
                        tools={conversationActivityTools}
                        registry={registry}
                        streaming={conversationSnapshot?.isStreaming}
                        waiting={conversationPrompts.length > 0}
                        onRecover={() => void recoverThread()}
                        onStop={() => void window.tau?.abort(snapshot?.sessionId)}
                      />
                    ) : undefined}
                    activityAfterMessageId={visibleToolAnchorId}
                    activities={(conversationSnapshot?.taskHistory ?? []).map((entry) => ({
                      id: entry.id,
                      afterMessageId: entry.anchorMessageId,
                      content: <TaskProgress progress={entry.progress} placement="transcript" />,
                    }))}
                    onCopyMessage={(message) => void copyMessage(message)}
                    onForkMessage={(message) => void forkMessage(message)}
                  />
                  {/* The tool block already says a run is in flight; two live rows
                      both duplicate the signal and collide with the virtual list. */}
                  {conversationSnapshot?.isStreaming && conversationActivityTools.length === 0
                    ? <LiveStatus startedAt={runStartedAt} />
                    : null}
                </div>
              </div>

              {!pendingNewThread && turnChanges.files.length > 0 ? (
                <div className="conversation-files-dock">
                  <ChangedFiles changes={turnChanges} onOpenDiff={openReview} />
                </div>
              ) : null}
              {conversationComposer}
                </>
              )}
            </main>

            {panels.length > 0 ? (
              <aside className="instrument-dock">
                {dockOpen ? (
                  <div className="panel-stage">
                    {panels.map((panel) => openedPanels.has(panel.id) ? (
                      <MountedPanel
                        key={panel.id}
                        Component={panel.Component}
                        active={activePanel === panel.id}
                        label={panel.label}
                        extensionName={panel.extensionName}
                      />
                    ) : null)}
                  </div>
                ) : null}
                <nav className="panel-rail">
                  {panels.map((panel) => (
                    <button
                      key={panel.id}
                      title={panel.label}
                      aria-label={panel.label}
                      className={dockOpen && activePanel === panel.id ? "active" : ""}
                      onClick={() => openPanel(panel.id)}
                    >
                      <PanelIcon name={panel.glyph} />
                    </button>
                  ))}
                  <span className="spacer" />
                  <button
                    title={dockOpen ? "Collapse panel" : "Expand panel"}
                    aria-label={dockOpen ? "Collapse panel" : "Expand panel"}
                    onClick={() => setDockOpen((value) => !value)}
                  >
                    {dockOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
                  </button>
                </nav>
              </aside>
            ) : null}
          </div>
          {overlays}
            </ObservatoryContext.Provider>
            </ChangesContext.Provider>
          </FilesContext.Provider>
        </WorkbenchContext.Provider>
      </WorkbenchShellContext.Provider>
    </ThreadStoreContext.Provider>
  );
}
