import type { HostSnapshot, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import { hostSnapshotFromThreadDetail, normalizeTranscriptCursorBoundaries, threadDetailFromHostSnapshot, type ThreadDetail, type TranscriptPage } from "../shared/host-protocol";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { ThreadDetailStore } from "../shared/thread-detail-store";
import { TranscriptHistoryCache } from "./transcript-history-cache";
import {
  captureTranscriptScrollAnchor,
  mergeTranscriptMessages,
  applyTranscriptBundleMerge,
  mergeTaskHistory,
  mergeTurnActivityHistory,
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
  TransitionToken,
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
  TransitionToken,
} from "./transcript-history-types";
export {
  captureTranscriptScrollAnchor,
  applyTranscriptBundleMerge,
  mergeTaskHistory,
  mergeTurnActivityHistory,
  mergeTranscriptMessages,
  retainsLoadedHistory,
  restoreTranscriptScrollAnchor,
} from "./transcript-history-page-state";

function applyTranscriptPageMetadata(
  base: ThreadDetail,
  page: TranscriptPage,
  cursorBoundaries: ThreadDetail["cursorBoundaries"] | undefined,
  transcriptWindow: ThreadDetail["transcriptWindow"] | undefined,
): ThreadDetail {
  return {
    ...base,
    olderCursor: page.olderCursor,
    cursorBeforeMessageId: page.cursorBeforeMessageId,
    cursorBoundaries,
    hasMore: page.hasMore,
    historyCompleteness: page.historyCompleteness,
    ...(transcriptWindow ? { transcriptWindow } : {}),
  };
}

export class TranscriptHistoryController {
  readonly preserveScrollRef: TranscriptHistoryPageState["preserveScrollRef"];
  readonly anchorRef: TranscriptHistoryPageState["anchorRef"];

  private state: TranscriptHistoryState;
  private readonly listeners = new Set<() => void>();
  private readonly cache: TranscriptHistoryCache;
  private readonly coordinator: TranscriptHistoryCoordinator;
  private readonly pageState: TranscriptHistoryPageState;

  constructor(initialSnapshot?: HostSnapshot, initialIndex?: ThreadIndexSnapshot, details?: ThreadDetailStore) {
    const initialDetail = initialSnapshot
      ? threadDetailFromHostSnapshot(initialSnapshot)
      : undefined;
    this.cache = new TranscriptHistoryCache(initialSnapshot, initialIndex, details);
    this.coordinator = new TranscriptHistoryCoordinator(initialSnapshot?.sessionId);
    this.pageState = new TranscriptHistoryPageState();
    this.preserveScrollRef = this.pageState.preserveScrollRef;
    this.anchorRef = this.pageState.anchorRef;
    if (initialDetail) {
      this.cache.setDetail({
        ...initialDetail,
      });
    }
    this.state = {
      sessionId: initialDetail?.sessionId,
      olderCursor: initialDetail?.olderCursor,
      historyCompleteness: initialDetail?.historyCompleteness,
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
    detail: ThreadDetail = threadDetailFromHostSnapshot(snapshot),
    request?: TranscriptBootstrapRequest,
  ): boolean {
    if (request && !this.isCurrentBootstrap(request)) return false;
    if (!request && this.state.loading && this.coordinator.isActiveSession(snapshot.sessionId)) {
      const applied = this.applyDetail(detail, snapshot);
      return applied !== undefined;
    }
    this.applyThreadState(snapshot.sessionId, snapshot.olderCursor, snapshot.historyCompleteness, false);
    this.cache.setDetail(detail);
    this.cache.setSnapshot(snapshot);
    this.publish({
      sessionId: snapshot.sessionId,
      olderCursor: snapshot.olderCursor,
      historyCompleteness: detail.historyCompleteness ?? snapshot.historyCompleteness,
      loading: false,
    });
    this.persistCache();
    return true;
  }

  applyDetail(detail: ThreadDetail, snapshot?: HostSnapshot): TranscriptDetailApplication | undefined {
    if (!this.acceptsDetail(detail.sessionId)) return undefined;
    const previous = this.cache.getDetail(detail.sessionId);
    const sameThreadPaging = this.state.loading
      && this.coordinator.isActiveSession(detail.sessionId)
      && previous?.sessionId === detail.sessionId;
    const keepHistory = retainsLoadedHistory(previous, detail);
    if (sameThreadPaging && !keepHistory) this.coordinator.cancelPagingRequest();
    const mergedBundle = applyTranscriptBundleMerge(
      keepHistory && previous ? previous : undefined,
      detail,
    );
    const { messages, taskHistory, turnActivityHistory, turnActivityHistoryComplete, cursorBoundaries, transcriptWindow } = mergedBundle;
    const renderedDetail: ThreadDetail = {
      ...detail,
      messages,
      taskHistory,
      turnActivityHistory,
      ...(turnActivityHistoryComplete !== undefined ? { turnActivityHistoryComplete } : {}),
      olderCursor: keepHistory ? previous?.olderCursor : detail.olderCursor,
      cursorBeforeMessageId: keepHistory ? previous?.cursorBeforeMessageId : detail.cursorBeforeMessageId,
      cursorBoundaries: keepHistory ? cursorBoundaries : detail.cursorBoundaries,
      hasMore: keepHistory ? previous.hasMore : detail.hasMore,
      historyCompleteness: keepHistory ? previous.historyCompleteness : detail.historyCompleteness,
      ...(transcriptWindow ? { transcriptWindow } : {}),
    };
    const renderedSnapshot = snapshot
      ? hostSnapshotFromThreadDetail(snapshot, renderedDetail)
      : undefined;
    const preservePagingRequest = sameThreadPaging && keepHistory;
    const preserveAnchor = !preservePagingRequest
      && keepHistory
      && this.coordinator.isActiveSession(renderedDetail.sessionId)
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
      ? { ...this.state, sessionId: renderedDetail.sessionId, olderCursor: renderedDetail.olderCursor, historyCompleteness: renderedDetail.historyCompleteness }
      : { sessionId: renderedDetail.sessionId, olderCursor: renderedDetail.olderCursor, historyCompleteness: renderedDetail.historyCompleteness, loading: false });
    this.persistCache();
    return { detail: renderedDetail, snapshot: renderedSnapshot };
  }

  beginThreadSwitch(sessionId?: string): TransitionToken {
    const generation = this.coordinator.beginThreadSwitch(sessionId);
    this.pageState.clear();
    this.publish({ ...this.state, loading: false, status: undefined });
    return generation;
  }

  isCurrentThreadTransition(generation: TransitionToken): boolean {
    return this.coordinator.isCurrentThreadTransition(generation);
  }

  confirmThreadTransition(generation: TransitionToken, sessionId: string): boolean {
    return this.coordinator.confirmThreadTransition(generation, sessionId);
  }

  prepareActionDetail(sessionId: string): boolean {
    if (!this.coordinator.isSwitching && !this.coordinator.isActiveSession(sessionId)) this.pageState.clear();
    const prepared = this.coordinator.prepareActionDetail(sessionId);
    return prepared;
  }

  acceptsDetail(sessionId: string): boolean {
    return this.coordinator.acceptsDetail(sessionId);
  }

  acceptsExternalPage(sessionId: string): boolean {
    return this.coordinator.acceptsExternalPage(sessionId);
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
    const pageBundle: TranscriptPage = {
      ...page,
      cursorBoundaries: normalizeTranscriptCursorBoundaries(
        page.cursorBoundaries,
        page.cursorBeforeMessageId,
        page.olderCursor,
      ),
    };
    const baseBundle = applyTranscriptBundleMerge(
      currentDetail,
      { messages: visibleMessages },
    );
    const mergedBundle = applyTranscriptBundleMerge(baseBundle, pageBundle, "prepend");
    const { messages, taskHistory, turnActivityHistory, turnActivityHistoryComplete, cursorBoundaries, transcriptWindow } = mergedBundle;
    const detail = currentDetail ? applyTranscriptPageMetadata({
      ...currentDetail,
      messages,
      taskHistory,
      turnActivityHistory,
      ...(turnActivityHistoryComplete !== undefined ? { turnActivityHistoryComplete } : {}),
    }, pageBundle, cursorBoundaries, transcriptWindow) : undefined;
    if (detail) this.cache.setDetail(detail);
    this.pageState.markAnchorMeasured(messages);

    let snapshot: HostSnapshot | undefined;
    const cachedSnapshot = this.cache.getSnapshot();
    if (cachedSnapshot?.sessionId === page.sessionId) {
      const snapshotBase = applyTranscriptBundleMerge(
        cachedSnapshot,
        currentDetail ?? { messages: visibleMessages },
      );
      const snapshotBundle = applyTranscriptBundleMerge(snapshotBase, pageBundle, "prepend");
      const snapshotDetail = applyTranscriptPageMetadata({
        ...(detail ?? threadDetailFromHostSnapshot(cachedSnapshot)),
        messages: snapshotBundle.messages,
        taskHistory: snapshotBundle.taskHistory,
        turnActivityHistory: snapshotBundle.turnActivityHistory,
        ...(snapshotBundle.turnActivityHistoryComplete !== undefined
          ? { turnActivityHistoryComplete: snapshotBundle.turnActivityHistoryComplete }
          : {}),
      }, pageBundle, snapshotBundle.cursorBoundaries, snapshotBundle.transcriptWindow);
      snapshot = hostSnapshotFromThreadDetail(cachedSnapshot, snapshotDetail);
      this.cache.setSnapshot(snapshot);
      this.persistCache();
    }
    this.publish({
      ...this.state,
      sessionId: page.sessionId,
      olderCursor: page.olderCursor,
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
    olderCursor?: HostTranscriptCursor,
    historyCompleteness?: TranscriptHistoryCompleteness,
    preserveAnchor = false,
  ): void {
    const lease = this.pageState.leaseForThreadState(preserveAnchor);
    this.coordinator.activateSession(sessionId);
    this.pageState.restoreLease(lease);
    this.state = {
      sessionId,
      olderCursor,
      historyCompleteness,
      loading: false,
    };
  }

  private publish(next: TranscriptHistoryState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
