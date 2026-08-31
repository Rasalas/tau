import type { HostSnapshot, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import { parseLocalTranscriptCursor, type LocalTranscriptCursor } from "../shared/transcript-cursor";
import { TranscriptHistoryCache } from "./transcript-history-cache";
import {
  captureTranscriptScrollAnchor,
  mergeTaskHistory,
  mergeTranscriptMessages,
  mergeTranscriptMessageIndexes,
  retainsLoadedHistory,
  restoreTranscriptScrollAnchor,
  TranscriptHistoryPageState,
} from "./transcript-history-page-state";
import { TranscriptHistoryCoordinator } from "./transcript-history-coordinator";
import type {
  TranscriptAnchorRestoreResult,
  TranscriptBootstrapRequest,
  TranscriptDetailApplication,
  TranscriptHistoryRequest,
  TranscriptHistoryState,
  TranscriptHistoryStatus,
  TranscriptPageApplication,
  TranscriptScrollAnchor,
} from "./transcript-history-types";
import type { TranscriptHistoryCompleteness } from "../shared/transcript-completeness";

export type {
  TranscriptAnchorRestoreResult,
  TranscriptBootstrapRequest,
  TranscriptDetailApplication,
  TranscriptHistoryRequest,
  TranscriptHistoryState,
  TranscriptHistoryStatus,
  TranscriptPageApplication,
  TranscriptScrollAnchor,
} from "./transcript-history-types";
export {
  captureTranscriptScrollAnchor,
  mergeTaskHistory,
  mergeTranscriptMessages,
  mergeTranscriptMessageIndexes,
  retainsLoadedHistory,
  restoreTranscriptScrollAnchor,
} from "./transcript-history-page-state";

function localCursor(value: string | undefined): LocalTranscriptCursor | undefined {
  if (value === undefined) return undefined;
  try { return parseLocalTranscriptCursor(value); }
  catch { return undefined; }
}

export class TranscriptHistoryController {
  readonly preserveScrollRef: TranscriptHistoryPageState["preserveScrollRef"];
  readonly anchorRef: TranscriptHistoryPageState["anchorRef"];

  private state: TranscriptHistoryState;
  private readonly listeners = new Set<() => void>();
  private readonly cache: TranscriptHistoryCache;
  private readonly coordinator: TranscriptHistoryCoordinator;
  private readonly pageState: TranscriptHistoryPageState;

  constructor(initialSnapshot?: HostSnapshot, initialIndex?: ThreadIndexSnapshot) {
    this.cache = new TranscriptHistoryCache(initialSnapshot, initialIndex);
    this.coordinator = new TranscriptHistoryCoordinator(initialSnapshot?.sessionId);
    this.pageState = new TranscriptHistoryPageState();
    this.preserveScrollRef = this.pageState.preserveScrollRef;
    this.anchorRef = this.pageState.anchorRef;
    if (initialSnapshot) {
      this.cache.setDetail({
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
        historyCompleteness: initialSnapshot.historyCompleteness,
      });
    }
    this.state = {
      sessionId: initialSnapshot?.sessionId,
      olderCursor: localCursor(initialSnapshot?.olderCursor),
      historyCompleteness: initialSnapshot?.historyCompleteness,
      loading: false,
    };
  }

  getSnapshot = (): TranscriptHistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getDetail(sessionId: string): ThreadDetail | undefined {
    return this.cache.getDetail(sessionId);
  }

  setThreadIndex(index: ThreadIndexSnapshot): void {
    this.cache.setThreadIndex(index);
  }

  getCurrentSnapshot(): HostSnapshot | undefined {
    return this.cache.getSnapshot();
  }

  persistCache(): void {
    this.cache.persist();
  }

  beginBootstrap(): TranscriptBootstrapRequest {
    return this.coordinator.beginBootstrap();
  }

  isCurrentBootstrap(request: TranscriptBootstrapRequest): boolean {
    return this.coordinator.isCurrentBootstrap(request);
  }

  syncSnapshot(
    snapshot: HostSnapshot,
    detail: ThreadDetail,
    request?: TranscriptBootstrapRequest,
  ): boolean {
    if (request && !this.isCurrentBootstrap(request)) return false;
    this.applyThreadState(snapshot.sessionId, snapshot.olderCursor, snapshot.historyCompleteness);
    this.cache.setDetail(detail);
    this.cache.setSnapshot(snapshot);
    this.publish({
      sessionId: snapshot.sessionId,
      olderCursor: localCursor(snapshot.olderCursor),
      historyCompleteness: detail.historyCompleteness ?? snapshot.historyCompleteness,
      loading: false,
    });
    this.persistCache();
    return true;
  }

  applyDetail(detail: ThreadDetail, snapshot?: HostSnapshot): TranscriptDetailApplication | undefined {
    if (!this.acceptsDetail(detail.sessionId)) return undefined;
    const previous = this.cache.getDetail(detail.sessionId);
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
      historyCompleteness: keepHistory ? previous.historyCompleteness : detail.historyCompleteness,
    };
    const renderedSnapshot = snapshot ? {
      ...snapshot,
      sessionId: renderedDetail.sessionId,
      messages,
      ...(transcriptMessageIndexes ? { transcriptMessageIndexes } : { transcriptMessageIndexes: undefined }),
      olderCursor: renderedDetail.olderCursor,
      historyCompleteness: renderedDetail.historyCompleteness,
      isStreaming: renderedDetail.isStreaming,
      activeTools: renderedDetail.activeTools,
      turnActivity: renderedDetail.turnActivity,
      taskProgress: renderedDetail.taskProgress,
      taskHistory,
      contextUsage: renderedDetail.contextUsage,
    } : undefined;
    const preservePagingRequest = this.state.loading && keepHistory;
    const preserveAnchor = !preservePagingRequest
      && keepHistory
      && this.coordinator.isActiveThread(renderedDetail.sessionId)
      && this.anchorRef.current !== undefined;
    if (!preservePagingRequest) this.applyThreadState(
      renderedDetail.sessionId,
      renderedDetail.olderCursor,
      renderedDetail.historyCompleteness,
      preserveAnchor,
    );
    this.cache.setDetail(renderedDetail);
    if (renderedSnapshot) this.cache.setSnapshot(renderedSnapshot);
    this.publish(preservePagingRequest
      ? { ...this.state, sessionId: renderedDetail.sessionId, olderCursor: localCursor(renderedDetail.olderCursor), historyCompleteness: renderedDetail.historyCompleteness }
      : { sessionId: renderedDetail.sessionId, olderCursor: localCursor(renderedDetail.olderCursor), historyCompleteness: renderedDetail.historyCompleteness, loading: false });
    this.persistCache();
    return { detail: renderedDetail, snapshot: renderedSnapshot };
  }

  beginThreadSwitch(threadId?: string): number {
    const generation = this.coordinator.beginThreadSwitch(threadId);
    this.pageState.clear();
    this.publish({ ...this.state, loading: false, status: undefined });
    return generation;
  }

  isCurrentThreadTransition(generation: number): boolean {
    return this.coordinator.isCurrentThreadTransition(generation);
  }

  confirmThreadTransition(generation: number, threadId: string): boolean {
    return this.coordinator.confirmThreadTransition(generation, threadId);
  }

  prepareActionDetail(threadId: string): boolean {
    if (!this.coordinator.isSwitching) this.pageState.clear();
    const prepared = this.coordinator.prepareActionDetail(threadId);
    return prepared;
  }

  acceptsDetail(threadId: string): boolean {
    return this.coordinator.acceptsDetail(threadId);
  }

  acceptsExternalPage(threadId: string): boolean {
    return this.coordinator.acceptsExternalPage(threadId);
  }

  beginLoad(anchor?: TranscriptScrollAnchor): TranscriptHistoryRequest | undefined {
    const sessionId = this.state.sessionId;
    const cursor = this.state.olderCursor;
    const request = this.coordinator.beginLoad(sessionId, cursor, this.state.loading);
    if (!request) return undefined;
    this.pageState.beginPaging(anchor);
    this.publish({ ...this.state, sessionId, loading: true, status: undefined });
    return request;
  }

  isCurrent(request: TranscriptHistoryRequest, sessionId?: string): boolean {
    return this.coordinator.isCurrent(request, sessionId ?? this.state.sessionId);
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

    const currentDetail = this.cache.getDetail(page.sessionId);
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
      historyCompleteness: page.historyCompleteness,
    } : undefined;
    if (detail) this.cache.setDetail(detail);
    this.pageState.markAnchorMeasured(messages);

    let snapshot: HostSnapshot | undefined;
    const cachedSnapshot = this.cache.getSnapshot();
    if (cachedSnapshot?.sessionId === page.sessionId) {
      const snapshotIndexes = mergeTranscriptMessageIndexes(
        cachedSnapshot.messages,
        cachedSnapshot.transcriptMessageIndexes,
        page.messages,
        page.transcriptMessageIndexes,
        messages,
      );
      snapshot = {
        ...cachedSnapshot,
        messages,
        ...(snapshotIndexes ? { transcriptMessageIndexes: snapshotIndexes } : { transcriptMessageIndexes: undefined }),
        taskHistory,
        olderCursor: page.olderCursor,
        historyCompleteness: page.historyCompleteness,
      };
      this.cache.setSnapshot(snapshot);
      this.persistCache();
    }
    this.publish({
      ...this.state,
      sessionId: page.sessionId,
      olderCursor: localCursor(page.olderCursor),
      historyCompleteness: page.historyCompleteness,
    });
    return { messages, detail, snapshot };
  }

  completeSuccess(request: TranscriptHistoryRequest, loadedTurns: number): boolean {
    if (!this.isCurrent(request)) return false;
    this.pageState.finishPaging();
    this.publish({
      ...this.state,
      loading: false,
      status: { state: "success", loadedTurns },
    });
    return true;
  }

  /** Release a paging anchor after an explicit user interaction. */
  releaseAnchor(): boolean {
    if (!this.pageState.release()) return false;
    this.publish({ ...this.state });
    return true;
  }

  completeError(request: TranscriptHistoryRequest, message: string): boolean {
    if (!this.isCurrent(request)) return false;
    this.pageState.clear();
    this.publish({ ...this.state, loading: false, status: { state: "error", message } });
    return true;
  }

  abortRequest(request: TranscriptHistoryRequest): boolean {
    if (!this.isCurrent(request)) return false;
    this.pageState.clear();
    this.publish({ ...this.state, loading: false });
    return true;
  }

  private applyThreadState(
    sessionId: string,
    olderCursor?: string,
    historyCompleteness?: TranscriptHistoryCompleteness,
    preserveAnchor = false,
  ): void {
    const lease = this.pageState.leaseForThreadState(preserveAnchor);
    this.coordinator.activateThread(sessionId);
    this.pageState.restoreLease(lease);
    this.state = {
      sessionId,
      olderCursor: localCursor(olderCursor),
      historyCompleteness,
      loading: false,
    };
  }

  private publish(next: TranscriptHistoryState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
