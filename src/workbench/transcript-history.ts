import type { HostSnapshot, ThreadIndexSnapshot, UiMessage } from "../shared/contracts";
import { hostSnapshotFromThreadDetail, hostSnapshotWithCatalog, normalizeTranscriptCursorBoundaries, threadDetailFromHostSnapshot, type HostCatalog, type ProjectMetadata, type ThreadDetail, type TranscriptPage } from "../shared/host-protocol";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { ThreadDetailStore } from "../shared/thread-detail-store";
import { TranscriptPageWindow } from "./transcript-page-window";
import { TranscriptHistoryCache } from "./transcript-history-cache";
import {
  retainsLoadedHistory,
  TranscriptHistoryPageState,
} from "./transcript-history-page-state";
import { TranscriptHistoryCoordinator } from "./transcript-history-coordinator";
import type {
  TranscriptBootstrapRequest,
  TranscriptDetailApplication,
  TranscriptHistoryRequest,
  TranscriptHistoryState,
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

export class TranscriptHistoryController {
  readonly preserveScrollRef: TranscriptHistoryPageState["preserveScrollRef"];
  readonly anchorRef: TranscriptHistoryPageState["anchorRef"];

  private state: TranscriptHistoryState;
  private activeDetail?: ThreadDetail;
  private readonly window = new TranscriptPageWindow();
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
      this.activeDetail = initialDetail;
      this.window.reset(initialDetail);
      this.cache.setDetail(initialDetail);
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
    return this.activeDetail?.sessionId === sessionId ? this.activeDetail : this.cache.getDetail(sessionId);
  }

  setThreadIndex(index: ThreadIndexSnapshot): void {
    this.cache.setThreadIndex(index, this.getCacheSnapshot());
  }

  getCurrentSnapshot(): HostSnapshot | undefined {
    return this.cache.getSnapshot();
  }

  /** Only contiguous live tails may survive navigation or a cold start. */
  getCacheSnapshot(): HostSnapshot | undefined {
    const snapshot = this.cache.getSnapshot();
    const tail = this.window.latest;
    return snapshot && tail?.sessionId === snapshot.sessionId
      ? hostSnapshotFromThreadDetail(snapshot, tail) : snapshot;
  }

  persistCache(): void {
    this.cache.persist(this.getCacheSnapshot());
  }

  get navigationVersion(): number { return this.coordinator.navigationVersion; }

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
    this.activeDetail = detail;
    this.window.reset(detail);
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

  /**
   * Moves the merge base with the catalog. A thread detail carries no catalog,
   * so `applyDetail` re-projects whatever model, thinking level and tool list
   * the cached snapshot still holds — a base left behind undoes the user's
   * model change on the next detail the host pushes.
   */
  applyCatalog(catalog: HostCatalog): HostSnapshot | undefined {
    const current = this.cache.getSnapshot();
    if (!current) return undefined;
    if (catalog.sessionId !== undefined && current.sessionId !== catalog.sessionId) return undefined;
    const next = hostSnapshotWithCatalog(current, catalog);
    this.cache.setSnapshot(next);
    this.persistCache();
    return next;
  }

  /** Moves the merge base with the active project, as `applyCatalog` does with the catalog. */
  applyProject(project: ProjectMetadata): void {
    const current = this.cache.getSnapshot();
    if (!current) return;
    this.cache.setSnapshot({ ...current, ...project });
    this.persistCache();
  }

  applyDetail(detail: ThreadDetail, snapshot?: HostSnapshot): TranscriptDetailApplication | undefined {
    if (!this.acceptsDetail(detail.sessionId)) return undefined;
    const previous = this.coordinator.isActiveSession(detail.sessionId) ? this.activeDetail : undefined;
    const sameThreadPaging = this.state.loading
      && this.coordinator.isActiveSession(detail.sessionId)
      && previous?.sessionId === detail.sessionId;
    const keepHistory = retainsLoadedHistory(previous, detail);
    if (sameThreadPaging && !keepHistory) this.coordinator.cancelPagingRequest();
    if (keepHistory) this.window.refresh(detail);
    else this.window.reset(detail);
    const renderedDetail = this.window.detail()!;
    this.activeDetail = renderedDetail;
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
    this.cache.setDetail(this.window.latest ?? renderedDetail);
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

  canLoadAtAnchor(anchor: TranscriptScrollAnchor): boolean {
    return this.window.canPrependAt(anchor.messageId);
  }

  beginLoad(anchor?: TranscriptScrollAnchor): TranscriptHistoryRequest | undefined {
    if (anchor && !this.canLoadAtAnchor(anchor)) return undefined;
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

    if (request?.restoreLatest) {
      const latest = this.window.latest;
      if (!latest) return undefined;
      // Include live rows received since the last authoritative detail, but
      // never copy the historical prefix into the tail.
      const current = this.activeDetail?.messages ?? [];
      const first = current.findIndex((message) => message.id === latest.messages[0]?.id);
      const tailIds = new Set(current.slice(Math.max(0, first)).map((message) => message.id));
      const currentIds = new Set(current.map((message) => message.id));
      this.window.reset({ ...latest, messages: first < 0 ? latest.messages : visibleMessages.filter((message) =>
        tailIds.has(message.id) || !currentIds.has(message.id)) });
      this.pageState.clear();
    }
    const pageBundle: TranscriptPage = {
      ...page,
      cursorBoundaries: normalizeTranscriptCursorBoundaries(page.cursorBoundaries, page.cursorBeforeMessageId, page.olderCursor),
    };
    const detail = request?.restoreLatest ? this.window.detail() : this.window.prepend(pageBundle, visibleMessages);
    if (!detail) return undefined;
    this.activeDetail = detail;
    this.cache.setDetail(this.window.latest ?? detail);
    const messages = detail.messages;
    const cachedSnapshot = this.cache.getSnapshot();
    const snapshot = cachedSnapshot?.sessionId === page.sessionId
      ? hostSnapshotFromThreadDetail(cachedSnapshot, detail) : undefined;
    if (snapshot) {
      this.cache.setSnapshot(snapshot);
      this.persistCache();
    }
    this.publish({
      ...this.state,
      sessionId: page.sessionId,
      olderCursor: detail.olderCursor,
      historyCompleteness: detail.historyCompleteness,
    });
    return { messages, detail, snapshot };
  }

  /** Restart from the pinned live tail to re-read discarded middle pages. */
  beginRestoreLatest(): { page: TranscriptPage; request: TranscriptHistoryRequest } | undefined {
    const tail = this.window.latest;
    if (!this.window.hasGap || !tail) return undefined;
    this.coordinator.cancelPagingRequest();
    const request = this.coordinator.beginLoad(tail.sessionId, tail.olderCursor, false);
    if (!request) return undefined;
    return { page: { ...tail, hasMore: Boolean(tail.olderCursor) }, request: { ...request, restoreLatest: true } };
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
    this.state = { ...next, gapBeforeMessageId: this.window.gapBeforeMessageId, historyWindowEvicted: this.window.hasGap };
    for (const listener of this.listeners) listener();
  }
}
