import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from "react";
import { ChevronDown, Folder, PanelRight, PanelRightClose } from "lucide-react";
import type {
  ClientTurnIdentity,
  FileNode,
  HostEvent,
  HostSnapshot,
  ThreadIndexSnapshot,
  UiEditor,
  UiMessage,
  UiProject,
  UiPromptAttachment,
  UiSkillDraft,
  UiSession,
  PreparedPrompt,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  ServiceTier,
  ToolApprovalRequest,
  UiToolRun,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
  WorkspaceInfo,
  NewThreadRequestId,
} from "../shared/contracts";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { ChangedFiles } from "./components/ChangedFiles";
import { changesSinceTurn, changesTouchedByTools, clearCachedTurnActivity, readCachedTurnActivity, writeCachedTurnActivity } from "./turn-activity";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./components/LazyFeature";
import { Composer, type ComposerAttachmentHandle, type SubmitResult } from "./components/Composer";
import { ComposerScopeStore, createDraftKey, type DraftKey } from "./composer-scope-store";
import { errorMessage } from "./error-message";
import { multiSelectValue, type QuestionnaireChoice } from "./components/ExtensionPrompt";
import { optionForLabel, splitOption } from "../shared/extension-prompt-options";
import type { ContextBreakdown } from "./components/ContextMeter";
import { ThreadTitleMenu } from "./components/ThreadTitleMenu";
const LazyCommandPalette = lazy(() => import("./components/CommandPalette").then(({ CommandPalette }) => ({ default: CommandPalette })));
const LazySettingsModal = lazy(() => import("./components/SettingsModal").then(({ SettingsModal }) => ({ default: SettingsModal })));

const EMPTY_COMPOSER_ATTACHMENTS = { attachments: [] as const };

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
import { TranscriptViewport } from "./components/TranscriptViewport";
import { transcriptNavigationScopesEqual, type TranscriptNavigationScope, type TranscriptTurnStart } from "./components/transcript-navigation";
import type { TranscriptActivity } from "./components/transcript-activity";
import { TaskProgress } from "./components/TaskProgress";
import { ProjectPicker } from "./components/ProjectPicker";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";
import { bundledExtensions } from "./extensions";
import { readBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { preferences, type AccessLevel } from "./preferences";
import { createNewThreadDraft, draftKey, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
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
  FilesContext,
  ChangesContext,
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

const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
type CheckpointStatus = "queued" | "waiting" | "capturing" | "persisting" | "ready" | "failed";

function questionKey(sessionId: string, index: number): string {
  return `${sessionId}:${index}`;
}

/**
 * Navigation belongs to the semantic transcript, not to whichever host action
 * happened to cause it to load. A prepared draft has its own transcript scope
 * until Pi assigns the real session ID after the first send.
 */
export function transcriptNavigationScopeKey(
  snapshot: Pick<HostSnapshot, "cwd" | "sessionId"> | undefined,
  pending?: NewThreadDraft,
): string {
  const project = pending?.projectPath ?? snapshot?.cwd ?? "";
  const thread = pending ? `draft:${pending.draftId}` : snapshot?.sessionId ?? "";
  return `project:${project}\u0000thread:${thread}`;
}

function transcriptNavigationScope(
  snapshot: Pick<HostSnapshot, "cwd" | "sessionId"> | undefined,
  pending?: NewThreadDraft,
): TranscriptNavigationScope {
  return pending
    ? { kind: "draft", projectPath: pending.projectPath, draftId: pending.draftId }
    : { kind: "session", projectPath: snapshot?.cwd, sessionId: snapshot?.sessionId ?? "" };
}

export interface TranscriptSubmissionIdentity {
  turnId: string;
  scopeKey: string;
  scope: TranscriptNavigationScope;
  draftId?: string;
}

/**
 * Late send failures may still clean up their own optimistic entry, but they
 * may only restore composer UI while the exact logical request and semantic
 * transcript scope remain current.
 */
export function isCurrentTranscriptSubmission(
  current: TranscriptTurnStart | undefined,
  currentScopeKey: string,
  currentDraftId: string | undefined,
  captured: TranscriptSubmissionIdentity,
): boolean {
  return current?.turnId === captured.turnId
    && currentScopeKey === captured.scopeKey
    && transcriptNavigationScopesEqual(current.scope, captured.scope)
    && currentDraftId === captured.draftId;
}

export function optimisticThreadSnapshot(
  snapshot: HostSnapshot,
  target: UiSession,
  detail: ThreadDetail,
): HostSnapshot {
  return hostSnapshotFromThreadDetail(
    {
      ...snapshot,
      sessionName: undefined,
      sessionTitle: target.title,
      branch: target.branch,
      // Capability is thread-scoped; the target's catalog update will restore
      // it after the switch rather than leaking the previous thread's value.
      supportsImageInput: false,
      ...(detail.backendKind ? { backendKind: detail.backendKind } : {}),
      ...(detail.threadId ? { threadId: detail.threadId } : {}),
      ...(detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : {}),
    },
    { ...detail, isStreaming: false },
  );
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
  supportsImageInput: true,
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

export function skillPresentationForDraft(
  draft: UiSkillDraft,
): UiMessage["skill"] {
  return {
    name: draft.name,
    command: draft.command,
    copyText: draft.visibleText ? `${draft.command} ${draft.visibleText}` : draft.command,
  };
}

let fallbackClientMessageCounter = 0;

export function createClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);
  fallbackClientMessageCounter += 1;
  return `client-${Date.now()}-${fallbackClientMessageCounter}`;
}

export function reconcileOptimisticMessages(
  pending: readonly OptimisticUserMessage[],
  authoritative: readonly UiMessage[],
): OptimisticUserMessage[] {
  const confirmed = authoritative.filter((message) => message.role === "user");
  const used = new Set<number>();
  return pending.filter((entry) => {
    const index = confirmed.findIndex((message, at) => !used.has(at) && matchesTranscriptTurnMessage(message, {
      turnId: entry.message.clientTurnId ?? "",
      clientMessageId: entry.message.clientMessageId,
      messageId: entry.message.id,
      text: entry.message.text,
      timestamp: entry.message.timestamp,
    }));
    if (index < 0) return true;
    used.add(index);
    return false;
  });
}

/**
 * Authoritative messages are chronological. Optimistic entries are few and
 * arrive at the tail of a send, so insert them with binary search instead of
 * sorting the complete transcript on every assistant delta.
 */
export function mergeTranscriptMessages(
  authoritative: readonly UiMessage[],
  optimistic: readonly UiMessage[],
): UiMessage[] {
  if (optimistic.length === 0) return authoritative as UiMessage[];
  const merged = [...authoritative];
  for (const message of optimistic) {
    let low = 0;
    let high = merged.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (merged[middle].timestamp <= message.timestamp) low = middle + 1;
      else high = middle;
    }
    merged.splice(low, 0, message);
  }
  return merged;
}

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

interface NewThreadSubmissionCompletion {
  pending: NewThreadDraft;
  sessionId: string;
  optimisticId: string;
  prompt: string;
  scope: DraftKey | undefined;
  requestId: NewThreadRequestId;
  result?: HostActionResult;
}

function LiveStatus({ startedAt, label = "Pi is working" }: { startedAt?: number; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="live-status"><span className="spinner" /><span>{label}{startedAt ? ` · ${elapsedLabel(now - startedAt)}` : ""}</span></div>;
}

/**
 * The composer owns transient editor state (selection, menus and focus), so
 * its host stays mounted while the surrounding conversation changes mode.
 * Animate the measured position change with FLIP; reduced-motion users get a
 * single immediate placement instead.
 */
function ComposerHost({ start, children }: { start: boolean; children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previousRectRef = useRef<DOMRect | undefined>(undefined);
  const previousModeRef = useRef(start);
  const frameRef = useRef<number | undefined>(undefined);
  const cleanupRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node) return undefined;
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
    if (cleanupRef.current !== undefined) window.clearTimeout(cleanupRef.current);
    frameRef.current = undefined;
    cleanupRef.current = undefined;

    const previous = previousRectRef.current;
    const current = node.getBoundingClientRect();
    previousRectRef.current = current;
    const modeChanged = previousModeRef.current !== start;
    previousModeRef.current = start;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!modeChanged || !previous || reduceMotion) {
      node.style.transition = "";
      node.style.transform = "";
      node.style.willChange = "";
      return undefined;
    }

    const deltaX = previous.left - current.left;
    const deltaY = previous.top - current.top;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return undefined;

    node.style.transition = "none";
    node.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    node.style.willChange = "transform";
    // Force the inverse transform to be painted before releasing it, otherwise
    // browsers are free to collapse the two geometry states into one frame.
    void node.offsetWidth;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined;
      node.style.transition = "transform 220ms cubic-bezier(.2, .8, .2, 1)";
      node.style.transform = "translate3d(0, 0, 0)";
      cleanupRef.current = window.setTimeout(() => {
        cleanupRef.current = undefined;
        node.style.transition = "";
        node.style.transform = "";
        node.style.willChange = "";
      }, 240);
    });
    return () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
      if (cleanupRef.current !== undefined) window.clearTimeout(cleanupRef.current);
      frameRef.current = undefined;
      cleanupRef.current = undefined;
      node.style.transition = "";
      node.style.transform = "";
      node.style.willChange = "";
    };
  }, [start]);

  return <div ref={hostRef} className={`conversation-composer-host ${start ? "start" : "docked"}`}>{children}</div>;
}

export function useTailScroll(
  ref: RefObject<HTMLDivElement | null>,
  updates: readonly unknown[],
  resetKey?: unknown,
  preserveScrollRefOrPosition?: RefObject<boolean | undefined> | boolean,
  preservePosition = false,
): void {
  // Keep the old boolean fourth argument usable for focused hook tests and
  // callers, while the transcript controller uses its mutable preservation
  // ref and the paging state occupies the fifth argument.
  const preserveScrollRef = typeof preserveScrollRefOrPosition === "object"
    ? preserveScrollRefOrPosition
    : undefined;
  const preservePositionValue = typeof preserveScrollRefOrPosition === "boolean"
    ? preserveScrollRefOrPosition
    : preservePosition;
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | undefined>(undefined);
  const preservePositionRef = useRef(preservePositionValue);
  const skipTailAfterPreserveRef = useRef(false);
  preservePositionRef.current = preservePositionValue;
  const scheduleTail = () => {
    if (preserveScrollRef?.current) {
      pinnedRef.current = false;
      return;
    }
    if (preservePositionRef.current) {
      skipTailAfterPreserveRef.current = true;
      return;
    }
    if (skipTailAfterPreserveRef.current) {
      skipTailAfterPreserveRef.current = false;
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
    if (preservePositionValue) {
      skipTailAfterPreserveRef.current = true;
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
      return;
    }
    scheduleTail();
  // The array identity is intentionally controlled by the caller's visible records.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...updates, preservePositionValue]);
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
  const [transcriptHistory] = useState(() => new TranscriptHistoryController(
    cachedBootstrap?.snapshot,
    cachedBootstrap?.threadIndex,
  ));
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const threadActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);

  const [snapshot, setSnapshot] = useState<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const cachedSnapshotRef = useRef<HostSnapshot | undefined>(cachedBootstrap?.snapshot);
  const cachedIndexRef = useRef<ThreadIndexSnapshot | undefined>(cachedBootstrap?.threadIndex);
  // Run state lives in the thread store, fed by the host's per-thread status
  // events. Deriving it here keeps the composer, the live row and the rail from
  // ever disagreeing about whether the visible thread is working.
  const visibleStreaming = Boolean(snapshot && threadActivity.runningThreadIds.includes(snapshot.sessionId));
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
  const [turnCheckpoints, setTurnCheckpoints] = useState<UiTurnCheckpoint[]>(cachedBootstrap?.snapshot.turnCheckpoints ?? []);
  const turnCheckpointsRef = useRef(turnCheckpoints);
  turnCheckpointsRef.current = turnCheckpoints;
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
  const [checkpointStatus, setCheckpointStatus] = useState<CheckpointStatus>();
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
  // Legacy sessions may only have the old renderer cache. A settled run with
  // no durable checkpoint must not leave that stale cache looking current.
  const [turnSettledWithoutCheckpoint, setTurnSettledWithoutCheckpoint] = useState(false);
  const [activePanel, setActivePanel] = useState("");
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
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
  } = newThreadController;
  const pendingNewThreadRef = useRef(pendingNewThread);
  pendingNewThreadRef.current = pendingNewThread;
  const [transcriptTurnStart, setTranscriptTurnStartState] = useState<TranscriptTurnStart>();
  const [settingsPage, setSettingsPage] = useState<string>();
  const [review, setReview] = useState<{
    path?: string;
    primaryPush: boolean;
    checkpointId?: string;
    sessionId?: string;
  }>();
  const [committing, setCommitting] = useState(false);
  const [composerSeed, setComposerSeed] = useState<string>();
  const [composerScopeStore] = useState(() => new ComposerScopeStore());
  const [notice, setNotice] = useState<string>();
  const [dockOpen, setDockOpen] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerAttachmentRef = useRef<ComposerAttachmentHandle>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptTurnSequenceRef = useRef(0);
  const transcriptTurnStartRef = useRef<TranscriptTurnStart | undefined>(undefined);
  const detailStoreRef = useRef(new ThreadDetailStore(5));
  const activeWorkspaceRef = useRef(cachedBootstrap?.snapshot.cwd ?? "");
  const changesRequestRef = useRef(0);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const workspaceRequestRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolAnchorRef = useRef<string | undefined>(undefined);
  toolAnchorRef.current = toolAnchorId;
  const assistantStartsRef = useRef(new Map<string, number>());
  /** Empty live assistant rows wait here until a durable checkpoint proves they are visible. */
  const pendingAssistantAnchorsRef = useRef(new Map<string, { id: string; timestamp: number; beforeMessageId?: string }>());
  const pendingDeltasRef = useRef(new Map<string, { text: string; thinking: string }>());
  const deltaFrameRef = useRef<number | undefined>(undefined);
  const pendingToolUpdatesRef = useRef(new Map<string, string>());
  const toolFrameRef = useRef<number | undefined>(undefined);
  const runningThreadRef = useRef<string>("");
  const activeDraftKey = draftKey(snapshot?.sessionId, pendingNewThread);
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
    setTools((current) => current.map((tool) => {
      const output = pending.get(tool.id);
      return output === undefined || output === tool.output ? tool : { ...tool, output };
    }));
  }, []);

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
    turnCheckpointsRef.current = next.turnCheckpoints ?? [];
    setTurnCheckpoints(turnCheckpointsRef.current);
    setCheckpointStatus(undefined);
    setTurnSettledWithoutCheckpoint(false);
    const restoredActivity = next.turnActivity ?? cachedActivity;
    setTools(restoredActivity?.tools ?? []);
    setToolAnchorId(restoredActivity?.anchorMessageId);
    setTurnBaseline(cachedActivity?.baseline);
    setTurnActivitySessionId(restoredActivity ? next.sessionId : undefined);
    cachedSnapshotRef.current = next;
    writeBootstrapCache(next, cachedIndexRef.current);
    activeWorkspaceRef.current = next.cwd;
    return true;
  }, [replaceTranscriptMessages, threadStore, transcriptHistory]);

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
      if (shell) setSnapshot((current) => current && current.sessionId === shell.id ? { ...current, sessionTitle: shell.title, branch: shell.branch } : current);
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
        ...(currentSnapshot.sessionId === detail.sessionId ? {} : { supportsImageInput: false }),
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
      const reportedPrompt = detailForRender.messages.find((message) => message.role === "user")?.text;
      if (isCorrelatedCandidate && reportedPrompt !== undefined && pendingNewThreadRef.current) {
        const pending = pendingNewThreadRef.current;
        if (promoteFromHostReport(detail.sessionId, shell?.projectPath ?? pending.projectPath, reportedPrompt, detail.requestId)) {
          composerScopeStore.moveScope(
            createDraftKey(draftKey(undefined, pending)),
            createDraftKey(draftKey(detail.sessionId)),
          );
        }
      }
      threadStore.setActiveThread(detail.sessionId, detail.isStreaming);
      threadStore.setThreadRunning(detail.sessionId, detail.isStreaming);
      replaceTranscriptMessages(detailForRender.messages);
      turnCheckpointsRef.current = detailForRender.turnCheckpoints ?? [];
      setTurnCheckpoints(turnCheckpointsRef.current);
      setCheckpointStatus(undefined);
      setTurnSettledWithoutCheckpoint(false);
      const cachedActivity = readCachedTurnActivity(window.localStorage, detailForRender.sessionId);
      const restoredActivity = detailForRender.turnActivity ?? cachedActivity;
      setTools(restoredActivity?.tools ?? []);
      setToolAnchorId(restoredActivity?.anchorMessageId);
      setTurnBaseline(cachedActivity?.baseline);
      setTurnActivitySessionId(restoredActivity ? detailForRender.sessionId : undefined);
      setSnapshot((current) => {
        const next = application.snapshot ?? current;
        if (!next) return current;
        const enriched = {
          ...next,
          ...(detail.backendKind ? { backendKind: detail.backendKind } : {}),
          ...(detail.threadId ? { threadId: detail.threadId } : {}),
          ...(detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : {}),
          turnCheckpoints: detailForRender.turnCheckpoints,
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
      activeWorkspaceRef.current = update.project.cwd;
      setSnapshot((current) => current ? { ...current, ...update.project } : current);
      return;
    }
    if (update.type === "run" && update.sessionId === threadStore.getSnapshot().activeThreadId) {
      threadStore.setStreaming(update.event === "started");
    }
    if (update.type === "error") setNotice(update.message);
  }, [applyThreadIndex, applyTranscriptPage, composerScopeStore, promoteFromHostReport, replaceTranscriptMessages, setTranscriptTurnStart, threadStore, transcriptHistory]);

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

  const addEvent = useCallback((label: string, detail?: string, timestamp = Date.now()) => {
    setEvents((current) => [...current.slice(-99), { id: `${timestamp}-${Math.random()}`, label, detail, timestamp }]);
  }, []);
  noticeRef.current = setNotice;
  eventRef.current = addEvent;

  const workspaceCwd = safeMode ? undefined : snapshot?.cwd;
  useEffect(() => {
    if (!workspaceCwd || !window.tau) return;
    void runtimeExtensions.sync(workspaceCwd).catch((error) => setNotice(errorMessage(error)));
  }, [runtimeExtensions, workspaceCwd]);

  const refreshChanges = useCallback(async () => {
    if (!window.tau) return;
    const request = ++changesRequestRef.current;
    const cwd = activeWorkspaceRef.current;
    try {
      const next = await window.tau.getChanges();
      if (request === changesRequestRef.current && cwd === activeWorkspaceRef.current) setChanges(next);
    } catch (error) {
      if (request === changesRequestRef.current) setNotice(errorMessage(error));
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
      if (request === workspaceRequestRef.current) setNotice(errorMessage(error));
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
    if (event.type === "user-message-failed") {
      // Bridge commands acknowledge dispatch before the runtime completes. A
      // later failure still reconciles by the same request id, even if the
      // user switched threads in the meantime.
      setOptimisticMessages((current) => current.filter((entry) => entry.message.clientMessageId !== event.clientMessageId));
      if (event.sessionId === threadStore.getSnapshot().activeThreadId) setNotice(event.message);
      return;
    }
    // Every thread streams from its own runtime. Transcript and tool events for a
    // thread that is not on screen are dropped here; its persisted state is
    // re-read when it is opened.
    if (
      (event.type === "assistant-start" || event.type === "assistant-delta" || event.type === "assistant-thinking"
        || event.type === "assistant-end" || event.type === "assistant-anchor" || event.type === "user-message" || event.type === "tool-start" || event.type === "tool-update"
        || event.type === "tool-end" || event.type === "queue" || event.type === "turn-checkpoint"
        || event.type === "turn-checkpoint-status")
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
          setTurnSettledWithoutCheckpoint(false);
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
          setTurnSettledWithoutCheckpoint(true);
          void refreshChanges();
        }
        break;
      }
      case "turn-checkpoint-status":
        if (event.status === "ready" || event.status === "failed") setCheckpointStatus(undefined);
        else setCheckpointStatus(event.status);
        break;
      case "turn-checkpoint": {
        const next = [...turnCheckpointsRef.current.filter((entry) => entry.id !== event.checkpoint.id), event.checkpoint]
          .sort((left, right) => left.endedAt - right.endedAt);
        turnCheckpointsRef.current = next;
        setTurnCheckpoints(next);
        setTurnSettledWithoutCheckpoint(false);
        setSnapshot((current) => {
          if (!current || current.sessionId !== event.sessionId) return current;
          const updated = { ...current, turnCheckpoints: next };
          cachedSnapshotRef.current = updated;
          writeBootstrapCache(updated, cachedIndexRef.current);
          return updated;
        });
        const pending = pendingAssistantAnchorsRef.current.get(event.checkpoint.anchorMessageId);
        if (pending) {
          pendingAssistantAnchorsRef.current.delete(event.checkpoint.anchorMessageId);
        }
        if (pending && (event.checkpoint.completeness === "partial"
          || (event.checkpoint.fileCount ?? event.checkpoint.files.length) > 0)) {
          setMessages((current) => {
            if (current.some((message) => message.sourceEntryId === event.checkpoint.anchorMessageId)) return current;
            const existing = current.find((message) => message.id === pending.id);
            if (existing) {
              return current.map((message) => message.id === pending.id
                ? { ...message, sourceEntryId: event.checkpoint.anchorMessageId }
                : message);
            }
            const anchor: UiMessage = {
              id: pending.id,
              sourceEntryId: event.checkpoint.anchorMessageId,
              role: "assistant",
              text: "",
              timestamp: pending.timestamp,
            };
            const beforeIndex = pending.beforeMessageId === undefined
              ? -1
              : current.findIndex((message) => message.id === pending.beforeMessageId
                || message.sourceEntryId === pending.beforeMessageId);
            return beforeIndex < 0
              ? [...current, anchor]
              : [...current.slice(0, beforeIndex), anchor, ...current.slice(beforeIndex)];
          });
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
        if (!transcriptMessageIndexRef.current!.has(event.id)) {
          appendTranscriptMessage({
            id: event.id,
            role: "assistant",
            text: "",
            timestamp: assistantStartsRef.current.get(event.id) ?? Date.now(),
          });
        }
        queueAssistantDelta(event.id, "text", event.delta);
        break;
      case "assistant-thinking":
        // Pi presents this phase as working state rather than transcript content.
        break;
      case "assistant-end":
        flushAssistantDeltas();
        assistantStartsRef.current.delete(event.message.id);
        if (!event.message.text) {
          transcriptMessageIndexRef.current!.remove(event.message.id);
          replaceTranscriptMessages(transcriptMessageIndexRef.current!.messages);
        } else if (transcriptMessageIndexRef.current!.has(event.message.id)) {
          updateTranscriptMessages(new Map([[event.message.id, () => event.message]]));
        } else {
          appendTranscriptMessage(event.message);
        }
        break;
      case "assistant-anchor":
        pendingAssistantAnchorsRef.current.set(event.sourceEntryId, {
          id: event.id,
          timestamp: event.timestamp,
          ...(event.beforeMessageId ? { beforeMessageId: event.beforeMessageId } : {}),
        });
        setMessages((current) => {
          const existing = current.find((message) => message.id === event.id
            || message.sourceEntryId === event.sourceEntryId);
          if (existing) {
            pendingAssistantAnchorsRef.current.delete(event.sourceEntryId);
            const next = current.map((message) => message.id === event.id
              || message.sourceEntryId === event.sourceEntryId
                ? { ...message, sourceEntryId: event.sourceEntryId }
              : message);
            messagesRef.current = next;
            return next;
          }
          // A text-empty assistant is intentionally omitted from assistant-end
          // events. Only insert its marker when the corresponding checkpoint is
          // already known; a historical checkpoint arriving without this live
          // anchor must never be appended to the transcript tail.
          const checkpoint = turnCheckpointsRef.current.find((entry) => entry.anchorMessageId === event.sourceEntryId);
          if (!checkpoint || (checkpoint.completeness !== "partial"
            && (checkpoint.fileCount ?? checkpoint.files.length) === 0)) return current;
          pendingAssistantAnchorsRef.current.delete(event.sourceEntryId);
          const anchor: UiMessage = {
            id: event.id,
            sourceEntryId: event.sourceEntryId,
            role: "assistant",
            text: "",
            timestamp: event.timestamp,
          };
          const beforeIndex = event.beforeMessageId === undefined
            ? -1
            : current.findIndex((message) => message.id === event.beforeMessageId
              || message.sourceEntryId === event.beforeMessageId);
          const next = beforeIndex < 0
            ? [...current, anchor]
            : [...current.slice(0, beforeIndex), anchor, ...current.slice(beforeIndex)];
          messagesRef.current = next;
          return next;
        });
        break;
      case "user-message":
        if (transcriptMessageIndexRef.current!.has(event.message.id)) {
          updateTranscriptMessages(new Map([[event.message.id, () => event.message]]));
        } else {
          appendTranscriptMessage(event.message);
        }
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
      case "event-log":
        if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) {
          addEvent(event.label, event.detail, event.timestamp);
        }
        break;
      case "error":
        if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) setNotice(event.message);
        break;
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
        if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) {
          setUiPrompts((current) => current.filter((entry) => entry.id !== event.id));
        }
        break;
      case "notice":
        if (!event.sessionId || event.sessionId === threadStore.getSnapshot().activeThreadId) setNotice(event.message);
        break;
      case "queue":
        setQueue([...event.steering, ...event.followUp]);
        addEvent("queue.changed", `${event.steering.length} steering · ${event.followUp.length} follow-up`);
        break;
    }
  }, [addEvent, appendTranscriptMessage, applyHostUpdate, applyThreadIndex, flushAssistantDeltas, queueAssistantDelta, queueToolUpdate, refreshChanges, replaceTranscriptMessages, threadStore, updateTranscriptMessages]);

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
          branch: bootstrap.project.branch,
          sessionId: bootstrap.detail.sessionId,
          sessionTitle: bootstrap.threadIndex.sessions.find((thread) => thread.id === bootstrap.detail.sessionId)?.title ?? "Untitled thread",
          backendKind: bootstrap.detail.backendKind ?? bootstrap.catalog.backendKind,
          models: bootstrap.catalog.models,
          model: bootstrap.catalog.model,
          runtimeCapabilities: bootstrap.catalog.runtimeCapabilities,
          thinkingLevel: bootstrap.catalog.thinkingLevel,
          thinkingLevels: bootstrap.catalog.thinkingLevels,
          serviceTier: bootstrap.catalog.serviceTier,
          serviceTierAvailable: bootstrap.catalog.serviceTierAvailable,
          allTools: bootstrap.catalog.allTools,
          composerCommands: bootstrap.catalog.composerCommands ?? [],
          extensionCount: bootstrap.catalog.extensionCount,
          supportsImageInput: bootstrap.catalog.supportsImageInput ?? false,
          messages: [],
          isStreaming: false,
          activeTools: [],
        }, bootstrap.detail);
        if (!applySnapshot(current, bootstrapRequest)) return;
        void refreshChanges();
        void refreshWorkspace();
      }).catch((error) => {
        if (transcriptHistory.isCurrentBootstrap(bootstrapRequest)) setNotice(errorMessage(error));
      });
      window.tau.listEditors().then(setEditors).catch(() => setEditors([]));
    } else {
      applyThreadIndex(mockThreadIndex);
      applySnapshot(mockSnapshot);
      addEvent("preview.mode", "Electron host unavailable; showing fixture state");
    }
    return unsubscribe;
  }, [addEvent, applySnapshot, applyThreadIndex, handleHostEvent, refreshChanges, refreshWorkspace, transcriptHistory]);

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

  const loadTranscriptPage = useCallback(async (sessionId: string, cursor: HostTranscriptCursor) => {
    if (!window.tau) throw new Error("Transcript history requires the Electron host.");
    return window.tau.loadTranscript(sessionId, cursor);
  }, []);

  useTailScroll(transcriptRef, [messages, tools, changes, turnBaseline], snapshot?.sessionId, transcriptHistory.preserveScrollRef);

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

  const openCheckpointReview = useCallback((checkpointId: string, path?: string) => {
    const checkpoint = turnCheckpoints.find((entry) => entry.id === checkpointId);
    if (!checkpoint) {
      setNotice("This turn checkpoint is no longer available.");
      return;
    }
    setReview({ path, primaryPush: false, checkpointId, sessionId: checkpoint.sessionId });
  }, [turnCheckpoints]);

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
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
      return false;
    }
  }, [acceptWorkspace, requireHost, snapshot?.cwd]);

  const removeProject = useCallback(async (project: UiProject) => {
    if (!requireHost("Project removal")) return;
    try {
      applyActionResult(await window.tau!.removeProject(project.path));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const createThreadInProject = useCallback((project: UiProject) => {
    const nextDraft = createNewThreadDraft({ projectPath: project.path, projectName: project.name });
    const sourceScope = activeDraftKey;
    const destinationScope = draftKey(undefined, nextDraft);
    const sourceSnapshot = sourceScope ? composerScopeStore.getSnapshot(sourceScope) : undefined;
    if (sourceScope && destinationScope) composerScopeStore.moveScope(sourceScope, destinationScope);
    // A new project is a new draft scope, but changing projects before the
    // first send should not discard what the user already composed. Attachments
    // stay memory-only and move with the scope; text also survives a reload.
    const draft = sourceSnapshot?.draft ? { ...nextDraft, draft: sourceSnapshot.draft } : nextDraft;
    beginNewThread(draft);
    setNewThreadOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [activeDraftKey, beginNewThread, composerScopeStore]);

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
      setNotice(errorMessage(error));
      return false;
    }
  }, [acceptWorkspace, requireHost]);

  const switchSession = useCallback(async (path: string): Promise<boolean> => {
    if (!requireHost("Thread switching")) return false;
    invalidateNewThread();
    setPendingNewThread(undefined);
    writeNewThreadDraft(window.localStorage);
    const startedAt = performance.now();
    const previous = snapshot;
    const target = threadStore.getSnapshot().threads.find((session) => session.path === path);
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
  }, [addEvent, applyActionResult, applySnapshot, invalidateNewThread, requireHost, snapshot, threadStore]);

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

  const setServiceTier = useCallback(async (tier: ServiceTier) => {
    if (!requireHost("Service tier")) return;
    try {
      applyActionResult(await window.tau!.setServiceTier(tier));
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
      setTools([]);
      setToolAnchorId(undefined);
      setNotice("Closed the interrupted call. The thread can continue.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost, snapshot?.sessionId]);

  const compactContext = useCallback(async () => {
    if (!requireHost("Compaction")) return;
    try {
      applyActionResult(await window.tau!.compactContext());
      setNotice("Context compacted.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [applyActionResult, requireHost]);

  const openInEditor = useCallback(async (path?: string, editorOverride?: string) => {
    const editorId = editorOverride ?? settings.editorId ?? editors[0]?.id;
    if (!editorId) { setNotice("No supported editor found on PATH"); return; }
    if (!requireHost("Opening an editor")) return;
    try {
      await window.tau!.openInEditor(editorId, path);
    } catch (error) {
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
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
        composerScopeStore.setDraft(createDraftKey(draftKey(detail.detail.sessionId)), pendingDraft);
      }
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    } finally {
      setWorkspaceBusy(false);
    }
  }, [acceptWorkspace, composerScopeStore, requireHost]);

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
        setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
    }
  }, [snapshot?.branch, snapshot?.cwd, snapshot?.sessionId]);

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

  const forkMessage = useCallback(async (message: UiMessage) => {
    if (!message.sourceEntryId || !snapshot?.sessionId || !requireHost("Fork thread")) return;
    try {
      setNotice("Forking thread…");
      applyActionResult(await window.tau!.forkThread(message.sourceEntryId, snapshot.sessionId));
    } catch (error) {
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
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
      setNotice(errorMessage(error));
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
    focusComposer: (seed) => { if (seed !== undefined) setComposerSeed(seed); composerRef.current?.focus(); },
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

  const completeNewThreadSubmission = useCallback((completion: NewThreadSubmissionCompletion) => {
    const { pending, sessionId, optimisticId, prompt, scope, requestId, result } = completion;
    if (!isCurrentNewThreadRequest(pending, scope, requestId)) return;
    setOptimisticMessages((current) => current.map((entry) => entry.message.id === optimisticId
      ? { ...entry, scope: `session:${sessionId}` }
      : entry));
    if (scope) {
      composerScopeStore.moveScope(createDraftKey(scope), createDraftKey(draftKey(sessionId)));
    }
    writeNewThreadDraft(window.localStorage);
    setPendingNewThread(undefined);
    if (result) acceptWorkspace(result);
    threadStore.markRead(sessionId);
    void registry.notifyPromptSubmitted({
      prompt,
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
    }, actions).catch((error) => setNotice(errorMessage(error)));
  }, [acceptWorkspace, actions, composerScopeStore, isCurrentNewThreadRequest, registry, snapshot, threadStore]);

  const submit = useCallback(async (
    value: string,
    attachments: UiPromptAttachment[] = [],
    delivery?: "followUp" | "steer",
    skillDraft?: UiSkillDraft,
  ): Promise<SubmitResult> => {
    const text = skillDraft ? value : value.trim();
    const commandText = text.trim();
    if (!commandText && attachments.length === 0) return { accepted: false, message: "Enter a message or attach an image." };
    if (commandText === "/reload" && attachments.length === 0) {
      return (await reloadRuntime()) ? { accepted: true } : { accepted: false, message: "Runtime reload failed." };
    }
    if (commandText === "/rebuild" && attachments.length === 0) {
      return (await rebuildWorkbench()) ? { accepted: true } : { accepted: false, message: "Workbench rebuild failed." };
    }
    if (commandText === "/restart" && attachments.length === 0) {
      restartWorkbench();
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
    const clientTurn: ClientTurnIdentity = {
      clientTurnId: logicalTurnId,
      clientMessageId,
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
    const newThreadRequestId = newThreadRequestRef.current;
    const optimisticScope = submittedDraftKey ?? `session:${snapshot?.sessionId ?? "unknown"}`;
    if (!pendingNewThread && visibleStreaming) {
      setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      if (delivery === "steer") {
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
      } else {
        startTranscriptTurn(snapshot?.sessionId, true);
        const queuedText = optimisticText;
        setQueue((current) => [...current, queuedText]);
        try {
          if (!window.tau) throw new Error("Follow-up messages require the Electron host.");
          await window.tau.followUp(text, attachments, snapshot?.sessionId, clientTurn, prepared);
        } catch (error) {
          const currentSubmission = isCurrentSubmission();
          cancelTranscriptTurn();
          setOptimisticMessages((current) => current.filter((entry) => entry.message.id !== optimistic.id));
          setQueue((current) => {
            const index = current.lastIndexOf(queuedText);
            return index < 0 ? current : current.filter((_, at) => at !== index);
          });
          if (currentSubmission) {
            setNotice(String(error));
          }
          return { accepted: false, message: errorMessage(error) };
        }
        return { accepted: true };
      }
    }
    if (pendingNewThread) {
      const pending = pendingNewThread;
      const pendingKey = draftKey(undefined, pending);
      startTranscriptTurn(pending.sessionId, false, true);
      setOptimisticMessages((current) => [...current, { scope: optimisticScope, message: optimistic }]);
      try {
        if (!window.tau) throw new Error("New thread requires the Electron host.");
        if (pending.sessionId) {
          await window.tau.sendPrompt(text, attachments, pending.sessionId, clientTurn, prepared);
          completeNewThreadSubmission({ pending, sessionId: pending.sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId });
          return { accepted: true };
        }
        const result = await window.tau.newSession(text, attachments, pending.projectPath, clientTurn, prepared);
        if (!isCurrentNewThreadRequest(pending, submittedDraftKey, newThreadRequestId)) return result.submission;
        const created = result.updates.find((update) => update.type === "thread-detail");
        if (result.submission.accepted
          && created?.type !== "thread-detail"
          && result.requestId === newThreadRequestId) {
          markAwaitingPromotion({ pending, scope: submittedDraftKey, requestId: newThreadRequestId, prompt: text });
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
          return result.submission;
        }
        const sessionId = created?.type === "thread-detail" ? created.detail.sessionId : undefined;
        if (transcriptTurnStartRef.current?.turnId !== logicalTurnId
          || transcriptScopeKeyRef.current !== submissionScopeKey
          || pendingNewThreadRef.current?.draftId !== pending.draftId) {
          // The draft was abandoned while the host was creating its session.
          // Do not let a late result switch the newly selected thread back.
          writeComposerDraft(window.localStorage, pendingKey, "");
          return result.submission;
        }
        if (sessionId) {
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
          completeNewThreadSubmission({ pending, sessionId, optimisticId: optimistic.id, prompt: visiblePrompt, scope: submittedDraftKey, requestId: newThreadRequestId, result });
          return { accepted: true };
        } else {
          // Pi's own TUI creates the thread and reports it later; the draft
          // view stays until that report arrives.
          return { accepted: true };
        }
      } catch (error) {
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
  }, [acceptWorkspace, actions, activeDraftKey, appendTranscriptMessage, applyActionResult, completeNewThreadSubmission, isCurrentNewThreadRequest, pendingNewThread, rebuildWorkbench, registry, reloadRuntime, restartWorkbench, setTranscriptTurnStart, snapshot, threadStore, transcriptScopeKey, visibleStreaming]);

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
  const changesContributions = registry.getChangesContributions();
  const ChangesComponent = changesContributions[0]?.Component;
  const checkpointContributions = registry.getTurnCheckpointContributions();
  const CheckpointComponent = checkpointContributions[0]?.Component;
  const activityTools = useMemo(() => tools.filter((tool) => tool.name !== "todo"), [tools]);
  const loadedMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      ids.add(message.id);
      if (message.sourceEntryId) ids.add(message.sourceEntryId);
    }
    return ids;
  }, [messages]);
  const checkpointActivities = useMemo(() => (!CheckpointComponent || pendingNewThread ? [] : turnCheckpoints)
    // A persisted checkpoint may belong to a page that is not loaded yet. Do
    // not send it to the transcript with a tail fallback; it becomes visible at
    // its original position as soon as that page is fetched.
    .filter((checkpoint) => (checkpoint.completeness === "partial"
      || (checkpoint.fileCount ?? checkpoint.files.length) > 0) && loadedMessageIds.has(checkpoint.anchorMessageId))
    .map((checkpoint) => ({
      id: `turn-checkpoint-${checkpoint.id}`,
      afterMessageId: checkpoint.anchorMessageId,
      content: (
        <CheckpointComponent
            checkpoint={checkpoint}
            onOpenDiff={(path) => openCheckpointReview(checkpoint.id, path)}
            loadFiles={window.tau
              ? (cursor, limit) => window.tau!.getTurnFiles(checkpoint.sessionId, checkpoint.id, cursor, limit)
              : undefined}
          />
      ),
    })), [CheckpointComponent, loadedMessageIds, openCheckpointReview, pendingNewThread, turnCheckpoints]);

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

  const contextValue = useMemo(
    () => ({ snapshot, tools, events, fileTree, changes, registry, refreshFiles, loadFiles, refreshChanges, openReview, applySnapshot, handleHostEvent }),
    [snapshot, tools, events, fileTree, changes, registry, refreshFiles, loadFiles, refreshChanges, openReview, applySnapshot, handleHostEvent],
  );
  const shellContextValue = useMemo(() => ({ snapshot, registry }), [snapshot, registry]);
  const panelProject = useMemo(() => snapshot ? { cwd: snapshot.cwd } : undefined, [snapshot?.cwd]);
  const filesContextValue = useMemo(() => ({ fileTree, snapshot: panelProject, refreshFiles, loadFiles }), [fileTree, panelProject, refreshFiles, loadFiles]);
  const changesContextValue = useMemo(() => ({ changes, snapshot: panelProject, refreshChanges, openReview }), [changes, panelProject, refreshChanges, openReview]);
  const observatoryContextValue = useMemo(() => ({ events, snapshot, tools, registry }), [events, snapshot, tools, registry]);
  const reviewChanges = review?.checkpointId
    ? turnCheckpoints.find((checkpoint) => checkpoint.id === review.checkpointId) ?? NO_CHANGES
    : changes;
  const reviewContribution = registry.getReviewContributions(review?.checkpointId ? "historical" : "workspace")[0];
  const ReviewComponent = reviewContribution?.Component;
  const sidebarContributions = registry.getSidebarContributions();
  const commands = registry.getCommands();
  const activeEditor = editors.find((editor) => editor.id === settings.editorId) ?? editors[0];
  const scopedOptimisticMessages = useMemo(
    () => optimisticMessages.filter((entry) => entry.scope === activeDraftKey),
    [activeDraftKey, optimisticMessages],
  );
  const unconfirmedOptimisticMessages = useMemo(
    () => reconcileOptimisticMessages(scopedOptimisticMessages, messages).map((entry) => entry.message),
    [scopedOptimisticMessages, transcriptUserRevision],
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
    : latestActivityAnchor(conversationMessages, toolAnchorId);
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
  const conversationActivityTools = pendingNewThread ? [] : activityTools;
  const conversationPrompts = pendingNewThread ? [] : threadPrompts;
  const transcriptActivities = useMemo<readonly TranscriptActivity[]>(() => [
    ...((conversationSnapshot?.taskHistory ?? []).map((entry) => ({
      id: entry.id,
      afterMessageId: entry.anchorMessageId,
      content: <TaskProgress progress={entry.progress} placement="transcript" />,
    }))),
    ...checkpointActivities,
    ...(conversationActivityTools.length > 0 ? [{
      id: "turn-activity",
      afterMessageId: visibleToolAnchorId,
      fallbackToTail: true,
      content: <ToolGroup
        tools={conversationActivityTools}
        registry={registry}
        streaming={conversationSnapshot?.isStreaming}
        waiting={conversationPrompts.length > 0}
        onRecover={() => void recoverThread()}
        onStop={() => void window.tau?.abort(snapshot?.sessionId)}
      />,
    }] : []),
  ], [checkpointActivities, conversationActivityTools, conversationPrompts.length, conversationSnapshot?.isStreaming, conversationSnapshot?.taskHistory, recoverThread, registry, snapshot?.sessionId, visibleToolAnchorId]);
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
      scopeStore={composerScopeStore}
      seed={composerSeed}
      draftStorageKey={activeDraftKey}
      queue={queue}
      accessLevel={settings.accessLevel}
      contextUsage={snapshot?.contextUsage}
      contextBreakdown={contextBreakdown}
      textareaRef={composerRef}
      attachmentRef={composerAttachmentRef}
      onSubmit={(text, attachments, delivery, skillDraft) => submit(text ?? "", attachments, delivery, skillDraft)}
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
                  {ReviewComponent ? <LazyFeatureBoundary label="review">
                    <Suspense fallback={<LazyFeatureFallback label="review" />}>
                      <ReviewComponent
                        changes={reviewChanges}
                        selectedPath={review.path ?? reviewChanges.files[0]?.path}
                        editor={activeEditor}
                        busy={committing}
                        primaryPush={review.primaryPush}
                        onSelect={(path) => setReview((current) => current ? { ...current, path } : current)}
                        onBack={() => setReview(undefined)}
                        onCommit={(message, push) => void commit(message, push)}
                        onOpenInEditor={(path) => void openInEditor(path)}
                        readOnly={Boolean(review.checkpointId)}
                        checkpointTitle={review.checkpointId ? "Turn changes" : undefined}
                        loadFiles={review.checkpointId && window.tau
                          ? (cursor, limit) => window.tau!.getTurnFiles(
                            review.sessionId ?? snapshot?.sessionId ?? "",
                            review.checkpointId!,
                            cursor,
                            limit,
                          )
                          : undefined}
                        loadDiff={async (path, options) => {
                          if (!window.tau) return { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." };
                          if (review.checkpointId) {
                            return window.tau.getTurnFileDiff(
                              review.sessionId ?? snapshot?.sessionId ?? "",
                              review.checkpointId,
                              path,
                              options,
                            );
                          }
                          return window.tau.getFileDiff(path, options);
                        }}
                      />
                    </Suspense>
                  </LazyFeatureBoundary> : <div className="review-unavailable">The review extension is disabled.</div>}
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

            <main
              className={`conversation-column ${showStartScreen ? "conversation-start" : ""}`}
              onDragEnter={threadDropController.onDragEnter}
              onDragOver={threadDropController.onDragOver}
              onDragLeave={threadDropController.onDragLeave}
              onDrop={threadDropController.onDrop}
            >
              {threadDropController.state !== "idle" ? (
                <div className={`conversation-drop-overlay ${threadDropController.state}`} role="status" aria-live="polite">
                  <div className="conversation-drop-card">
                    <strong>{THREAD_DROP_FEEDBACK[threadDropController.state].title}</strong>
                    <span>{THREAD_DROP_FEEDBACK[threadDropController.state].description}</span>
                  </div>
                </div>
              ) : null}
              <section
                className="conversation-start-screen"
                aria-labelledby={showStartScreen ? "start-screen-title" : undefined}
              >
                <div className="conversation-start-content">
                  {showStartScreen ? (
                    <>
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
                    </>
                  ) : null}
                  <ComposerHost start={showStartScreen}>{conversationComposer}</ComposerHost>
                </div>
              </section>
              <div className="conversation-thread">
                {!showStartScreen ? (
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
                liveStatus={checkpointStatus === "queued" || checkpointStatus === "waiting"
                  ? <LiveStatus label="Waiting for workspace…" />
                  : conversationSnapshot?.isStreaming && conversationActivityTools.length === 0
                    ? <LiveStatus startedAt={runStartedAt} />
                    : undefined}
                onCopyMessage={(message) => void copyMessage(message)}
                onForkMessage={(message) => void forkMessage(message)}
              />}
              </TranscriptHistoryBoundary>

              {!pendingNewThread
                && turnChanges.files.length > 0
                && turnCheckpoints.length === 0
                && !turnSettledWithoutCheckpoint
                && ChangesComponent
                ? (
                <div className="conversation-files-dock">
                  <ChangesComponent changes={turnChanges} onOpenDiff={openReview} />
                </div>
              ) : null}
                </>
                ) : null}
              </div>
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
