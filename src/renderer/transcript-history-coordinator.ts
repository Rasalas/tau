import type { TranscriptCursor } from "../shared/transcript-cursor";
import type {
  TranscriptBootstrapRequest,
  TranscriptHistoryRequest,
  TransitionToken,
} from "./transcript-history-types";

/**
 * Generation and visible-thread coordination. The facade owns rendering state;
 * this module owns which asynchronous result is still allowed to commit.
 */
export class TranscriptHistoryCoordinator {
  private generation = 0;
  private activeThreadId = "";
  private pendingThreadId?: string;
  private switching = false;
  private bootstrapped = false;

  constructor(initialThreadId = "") {
    this.activeThreadId = initialThreadId;
  }

  beginBootstrap(): TranscriptBootstrapRequest {
    this.generation += 1;
    return { generation: this.generation };
  }

  isCurrentBootstrap(request: TranscriptBootstrapRequest): boolean {
    return request.generation === this.generation && !this.switching;
  }

  beginThreadSwitch(threadId?: string): TransitionToken {
    this.generation += 1;
    this.switching = true;
    this.pendingThreadId = threadId;
    return this.generation as TransitionToken;
  }

  isCurrentThreadTransition(generation: TransitionToken): boolean {
    return generation === this.generation && this.switching;
  }

  confirmThreadTransition(generation: TransitionToken, threadId: string): boolean {
    if (!this.isCurrentThreadTransition(generation)) return false;
    if (this.pendingThreadId && this.pendingThreadId !== threadId) return false;
    this.pendingThreadId = threadId;
    return true;
  }

  prepareActionDetail(threadId: string): boolean {
    if (this.switching) return this.pendingThreadId === threadId;
    if (this.isActiveThread(threadId)) return true;
    this.beginThreadSwitch(threadId);
    return true;
  }

  acceptsDetail(threadId: string): boolean {
    if (!this.bootstrapped) return true;
    if (this.switching) return this.pendingThreadId === threadId;
    if (this.activeThreadId && this.activeThreadId !== threadId) return false;
    return true;
  }

  acceptsExternalPage(threadId: string): boolean {
    return !this.switching && this.activeThreadId === threadId;
  }

  beginLoad(
    threadId: string | undefined,
    cursor: TranscriptCursor | undefined,
    loading: boolean,
  ): TranscriptHistoryRequest | undefined {
    if (!threadId || !cursor || loading || this.switching) return undefined;
    this.generation += 1;
    return { generation: this.generation, sessionId: threadId, cursor };
  }

  isCurrent(request: TranscriptHistoryRequest, threadId?: string): boolean {
    return request.generation === this.generation
      && request.sessionId === (threadId ?? request.sessionId)
      && !this.switching;
  }

  /** Commit a visible thread after bootstrap or a same-thread detail refresh. */
  activateThread(threadId: string): void {
    if (this.bootstrapped && !this.switching && this.activeThreadId === threadId) return;
    this.generation += 1;
    this.activeThreadId = threadId;
    this.pendingThreadId = undefined;
    this.switching = false;
    this.bootstrapped = true;
  }

  isActiveThread(threadId: string): boolean {
    return !this.switching && this.activeThreadId === threadId;
  }

  get isSwitching(): boolean { return this.switching; }
}
