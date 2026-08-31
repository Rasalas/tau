import type { HostSnapshot, ThreadIndexSnapshot, UiMessage, UiTaskProgressEntry } from "../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { writeBootstrapCache } from "./bootstrap-cache";

export interface TranscriptHistoryStatus {
  state: "success" | "error";
  message?: string;
  loadedTurns?: number;
}

export interface TranscriptHistoryState {
  sessionId?: string;
  olderCursor?: string;
  loading: boolean;
  status?: TranscriptHistoryStatus;
}

export interface TranscriptHistoryRequest {
  generation: number;
  sessionId: string;
  cursor: string;
}

export interface TranscriptScrollAnchor {
  messageId: string;
  viewportOffset: number;
  /** Number of leading rows to keep mounted until their real heights are measured. */
  measureThrough?: number;
}

export interface TranscriptPageApplication {
  messages: UiMessage[];
  detail?: ThreadDetail;
  snapshot?: HostSnapshot;
}

export interface TranscriptDetailApplication {
  detail: ThreadDetail;
  snapshot?: HostSnapshot;
}

export interface TranscriptAnchorRestoreResult {
  found: boolean;
  delta: number;
}

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

export function mergeTaskHistory(
  current: readonly UiTaskProgressEntry[] | undefined,
  incoming: readonly UiTaskProgressEntry[] | undefined,
): UiTaskProgressEntry[] | undefined {
  if (!current && !incoming) return undefined;
  const byId = new Map<string, UiTaskProgressEntry>();
  for (const entry of current ?? []) byId.set(entry.id, entry);
  for (const entry of incoming ?? []) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function retainsLoadedHistory(
  current: ThreadDetail | undefined,
  incoming: ThreadDetail,
): current is ThreadDetail {
  if (!current || current.sessionId !== incoming.sessionId || current.messages.length <= incoming.messages.length || incoming.messages.length === 0) return false;
  const currentIds = new Set(current.messages.map((message) => message.id));
  return incoming.messages.some((message) => currentIds.has(message.id));
}

export function mergeTranscriptMessageIndexes(
  currentMessages: readonly UiMessage[] | undefined,
  currentIndexes: readonly number[] | undefined,
  incomingMessages: readonly UiMessage[] | undefined,
  incomingIndexes: readonly number[] | undefined,
  mergedMessages: readonly UiMessage[],
): number[] | undefined {
  if (!currentIndexes && !incomingIndexes) return undefined;
  const indexesById = new Map<string, number>();
  currentMessages?.forEach((message, index) => {
    const rawIndex = currentIndexes?.[index];
    if (rawIndex !== undefined) indexesById.set(message.id, rawIndex);
  });
  incomingMessages?.forEach((message, index) => {
    const rawIndex = incomingIndexes?.[index];
    if (rawIndex !== undefined) indexesById.set(message.id, rawIndex);
  });
  const mergedIndexes = mergedMessages.map((message) => indexesById.get(message.id));
  return mergedIndexes.every((index): index is number => index !== undefined) ? mergedIndexes : undefined;
}

function messageRows(node: HTMLDivElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"));
}

export function captureTranscriptScrollAnchor(node: HTMLDivElement): TranscriptScrollAnchor | undefined {
  const rows = messageRows(node);
  if (rows.length === 0) return undefined;
  const viewport = node.getBoundingClientRect();
  const visible = rows.find((row) => {
    const rowRect = row.getBoundingClientRect();
    return rowRect.bottom > viewport.top && rowRect.top < viewport.bottom;
  })
    ?? rows[0];
  const rect = visible.getBoundingClientRect();
  return {
    messageId: visible.dataset.messageId ?? "",
    viewportOffset: rect.top - viewport.top,
  };
}

export function restoreTranscriptScrollAnchor(
  node: Pick<HTMLDivElement, "scrollTop" | "getBoundingClientRect" | "querySelectorAll">,
  anchor: TranscriptScrollAnchor,
): TranscriptAnchorRestoreResult {
  const row = Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"))
    .find((candidate) => candidate.dataset.messageId === anchor.messageId);
  if (!row) return { found: false, delta: 0 };
  const viewport = node.getBoundingClientRect();
  const delta = row.getBoundingClientRect().top - viewport.top - anchor.viewportOffset;
  if (Math.abs(delta) > 0.5) node.scrollTop += delta;
  return { found: true, delta };
}

export class TranscriptHistoryController {
  readonly preserveScrollRef: { current: boolean | undefined } = { current: undefined };
  readonly anchorRef: { current: TranscriptScrollAnchor | undefined } = { current: undefined };

  private state: TranscriptHistoryState;
  private readonly listeners = new Set<() => void>();
  private readonly details = new ThreadDetailStore(5);
  private cachedSnapshot?: HostSnapshot;
  private cachedIndex?: ThreadIndexSnapshot;
  private generation = 0;
  private activeSessionId = "";
  private pendingSessionId?: string;
  private switching = false;
  private bootstrapped = false;

  constructor(initialSnapshot?: HostSnapshot, initialIndex?: ThreadIndexSnapshot) {
    this.cachedSnapshot = initialSnapshot;
    this.cachedIndex = initialIndex;
    this.activeSessionId = initialSnapshot?.sessionId ?? "";
    this.bootstrapped = false;
    if (initialSnapshot) {
      this.details.set({
        sessionId: initialSnapshot.sessionId,
        messages: initialSnapshot.messages,
        transcriptMessageIndexes: initialSnapshot.transcriptMessageIndexes,
        isStreaming: initialSnapshot.isStreaming,
        activeTools: initialSnapshot.activeTools,
        turnActivity: initialSnapshot.turnActivity,
        taskProgress: initialSnapshot.taskProgress,
        taskHistory: initialSnapshot.taskHistory,
        contextUsage: initialSnapshot.contextUsage,
        olderCursor: initialSnapshot.olderCursor,
        hasMore: initialSnapshot.olderCursor !== undefined,
      });
    }
    this.state = {
      sessionId: initialSnapshot?.sessionId,
      olderCursor: initialSnapshot?.olderCursor,
      loading: false,
    };
  }

  getSnapshot = (): TranscriptHistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDetail(sessionId: string): ThreadDetail | undefined {
    return this.details.get(sessionId);
  }

  setThreadIndex(index: ThreadIndexSnapshot): void {
    this.cachedIndex = index;
    this.persistCache();
  }

  getCurrentSnapshot(): HostSnapshot | undefined {
    return this.cachedSnapshot;
  }

  persistCache(): void {
    writeBootstrapCache(this.cachedSnapshot, this.cachedIndex);
  }

  syncSnapshot(snapshot: HostSnapshot, detail: ThreadDetail): void {
    this.invalidate(snapshot.sessionId, snapshot.olderCursor);
    this.details.set(detail);
    this.cachedSnapshot = snapshot;
    this.publish({ sessionId: snapshot.sessionId, olderCursor: snapshot.olderCursor, loading: false });
    this.persistCache();
  }

  applyDetail(detail: ThreadDetail, snapshot?: HostSnapshot): TranscriptDetailApplication | undefined {
    if (!this.acceptsDetail(detail.sessionId)) return undefined;
    const previous = this.details.get(detail.sessionId);
    const keepHistory = retainsLoadedHistory(previous, detail);
    const messages = keepHistory
      ? mergeTranscriptMessages(previous.messages, detail.messages)
      : detail.messages;
    const taskHistory = keepHistory
      ? mergeTaskHistory(previous.taskHistory, detail.taskHistory)
      : detail.taskHistory;
    const transcriptMessageIndexes = mergeTranscriptMessageIndexes(
      previous?.messages,
      previous?.transcriptMessageIndexes,
      detail.messages,
      detail.transcriptMessageIndexes,
      messages,
    );
    const renderedDetail: ThreadDetail = {
      ...detail,
      messages,
      ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : { transcriptMessageIndexes: undefined }),
      taskHistory,
      olderCursor: keepHistory ? previous.olderCursor : detail.olderCursor,
      hasMore: keepHistory ? previous.hasMore : detail.hasMore,
    };
    const renderedSnapshot = snapshot ? {
      ...snapshot,
      sessionId: renderedDetail.sessionId,
      messages,
      ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : { transcriptMessageIndexes: undefined }),
      olderCursor: renderedDetail.olderCursor,
      isStreaming: renderedDetail.isStreaming,
      activeTools: renderedDetail.activeTools,
      turnActivity: renderedDetail.turnActivity,
      taskProgress: renderedDetail.taskProgress,
      taskHistory,
      contextUsage: renderedDetail.contextUsage,
    } : undefined;
    this.invalidate(renderedDetail.sessionId, renderedDetail.olderCursor);
    this.details.set(renderedDetail);
    if (renderedSnapshot) this.cachedSnapshot = renderedSnapshot;
    this.publish({ sessionId: renderedDetail.sessionId, olderCursor: renderedDetail.olderCursor, loading: false });
    this.persistCache();
    return { detail: renderedDetail, snapshot: renderedSnapshot };
  }

  beginSessionSwitch(sessionId?: string): number {
    this.generation += 1;
    this.switching = true;
    this.pendingSessionId = sessionId;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    this.publish({ ...this.state, loading: false, status: undefined });
    return this.generation;
  }

  isCurrentTransition(generation: number): boolean {
    return generation === this.generation && this.switching;
  }

  confirmTransition(generation: number, sessionId: string): boolean {
    if (!this.isCurrentTransition(generation)) return false;
    if (this.pendingSessionId && this.pendingSessionId !== sessionId) return false;
    this.pendingSessionId = sessionId;
    return true;
  }

  prepareActionDetail(sessionId: string): boolean {
    if (this.switching) return this.pendingSessionId === sessionId;
    this.beginSessionSwitch(sessionId);
    return true;
  }

  acceptsDetail(sessionId: string): boolean {
    if (!this.bootstrapped) return true;
    if (this.switching) return this.pendingSessionId === sessionId;
    if (!this.switching && this.activeSessionId && this.activeSessionId !== sessionId) return false;
    return true;
  }

  acceptsExternalPage(sessionId: string): boolean {
    return !this.switching && this.activeSessionId === sessionId;
  }

  beginLoad(anchor?: TranscriptScrollAnchor): TranscriptHistoryRequest | undefined {
    const sessionId = this.state.sessionId ?? this.activeSessionId;
    const cursor = this.state.olderCursor;
    if (!sessionId || !cursor || this.state.loading || this.switching) return undefined;
    this.generation += 1;
    const request = { generation: this.generation, sessionId, cursor };
    this.anchorRef.current = anchor;
    this.preserveScrollRef.current = true;
    this.publish({ ...this.state, sessionId, loading: true, status: undefined });
    return request;
  }

  isCurrent(request: TranscriptHistoryRequest, sessionId?: string): boolean {
    return request.generation === this.generation
      && request.sessionId === (sessionId ?? this.state.sessionId)
      && !this.switching;
  }

  applyPage(
    page: TranscriptPage,
    visibleMessages: readonly UiMessage[],
    request?: TranscriptHistoryRequest,
  ): TranscriptPageApplication | undefined {
    const accepted = request
      ? this.isCurrent(request, page.sessionId)
      : this.acceptsExternalPage(page.sessionId);
    if (!accepted) return undefined;

    const currentDetail = this.details.get(page.sessionId);
    const currentMessages = mergeTranscriptMessages(currentDetail?.messages ?? [], visibleMessages);
    const messages = mergeTranscriptMessages(currentMessages, page.messages, "prepend");
    const taskHistory = mergeTaskHistory(currentDetail?.taskHistory, page.taskHistory);
    const transcriptMessageIndexes = mergeTranscriptMessageIndexes(
      currentDetail?.messages,
      currentDetail?.transcriptMessageIndexes,
      page.messages,
      page.transcriptMessageIndexes,
      messages,
    );
    const detail = currentDetail ? {
      ...currentDetail,
      messages,
      ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : { transcriptMessageIndexes: undefined }),
      taskHistory,
      olderCursor: page.olderCursor,
      hasMore: page.hasMore,
    } : undefined;
    if (detail) this.details.set(detail);

    const anchor = this.anchorRef.current;
    if (anchor && anchor.measureThrough === undefined) {
      const anchorIndex = messages.findIndex((message) => message.id === anchor.messageId);
      if (anchorIndex >= 0) this.anchorRef.current = { ...anchor, measureThrough: anchorIndex + 1 };
    }

    let snapshot: HostSnapshot | undefined;
    if (this.cachedSnapshot?.sessionId === page.sessionId) {
      const snapshotIndexes = mergeTranscriptMessageIndexes(
        this.cachedSnapshot.messages,
        this.cachedSnapshot.transcriptMessageIndexes,
        page.messages,
        page.transcriptMessageIndexes,
        messages,
      );
      snapshot = {
        ...this.cachedSnapshot,
        messages,
        ...(snapshotIndexes ? { transcriptMessageIndexes: snapshotIndexes } : { transcriptMessageIndexes: undefined }),
        taskHistory,
        olderCursor: page.olderCursor,
      };
      this.cachedSnapshot = snapshot;
      this.persistCache();
    }
    this.publish({ ...this.state, sessionId: page.sessionId, olderCursor: page.olderCursor });
    return { messages, detail, snapshot };
  }

  completeSuccess(request: TranscriptHistoryRequest, loadedTurns: number): boolean {
    if (!this.isCurrent(request)) return false;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    this.publish({
      ...this.state,
      loading: false,
      status: { state: "success", loadedTurns },
    });
    return true;
  }

  completeError(request: TranscriptHistoryRequest, message: string): boolean {
    if (!this.isCurrent(request)) return false;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    this.publish({ ...this.state, loading: false, status: { state: "error", message } });
    return true;
  }

  abortRequest(request: TranscriptHistoryRequest): boolean {
    if (!this.isCurrent(request)) return false;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    this.publish({ ...this.state, loading: false });
    return true;
  }

  private invalidate(sessionId: string, olderCursor?: string): void {
    this.generation += 1;
    this.activeSessionId = sessionId;
    this.pendingSessionId = undefined;
    this.switching = false;
    this.bootstrapped = true;
    this.anchorRef.current = undefined;
    this.preserveScrollRef.current = undefined;
    this.state = { sessionId, olderCursor, loading: false };
  }

  private publish(next: TranscriptHistoryState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
