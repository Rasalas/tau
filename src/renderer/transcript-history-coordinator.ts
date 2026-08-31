import type { HostTranscriptCursor } from "../shared/transcript-cursor";
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
  private activeSessionId = "";
  private pendingSessionId?: string;
  private switching = false;
  private bootstrapped = false;

  constructor(initialSessionId = "") {
    this.activeSessionId = initialSessionId;
  }

  beginBootstrap(): TranscriptBootstrapRequest {
    this.generation += 1;
    return { generation: this.generation };
  }

  isCurrentBootstrap(request: TranscriptBootstrapRequest): boolean {
    return request.generation === this.generation && !this.switching;
  }

  beginThreadSwitch(sessionId?: string): TransitionToken {
    this.generation += 1;
    this.switching = true;
    this.pendingSessionId = sessionId;
    return this.generation as TransitionToken;
  }

  isCurrentThreadTransition(generation: TransitionToken): boolean {
    return generation === this.generation && this.switching;
  }

  confirmThreadTransition(generation: TransitionToken, sessionId: string): boolean {
    if (!this.isCurrentThreadTransition(generation)) return false;
    if (this.pendingSessionId && this.pendingSessionId !== sessionId) return false;
    this.pendingSessionId = sessionId;
    return true;
  }

  prepareActionDetail(sessionId: string): boolean {
    if (this.switching) return this.pendingSessionId === sessionId;
    if (this.isActiveSession(sessionId)) return true;
    this.beginThreadSwitch(sessionId);
    return true;
  }

  acceptsDetail(sessionId: string): boolean {
    if (!this.bootstrapped) return true;
    if (this.switching) return this.pendingSessionId === sessionId;
    if (this.activeSessionId && this.activeSessionId !== sessionId) return false;
    return true;
  }

  acceptsExternalPage(sessionId: string): boolean {
    return !this.switching && this.activeSessionId === sessionId;
  }

  beginLoad(
    sessionId: string | undefined,
    cursor: HostTranscriptCursor | undefined,
    loading: boolean,
  ): TranscriptHistoryRequest | undefined {
    if (!sessionId || !cursor || loading || this.switching) return undefined;
    this.generation += 1;
    return { generation: this.generation, sessionId, cursor };
  }

  isCurrent(request: TranscriptHistoryRequest, sessionId?: string): boolean {
    return request.generation === this.generation
      && request.sessionId === (sessionId ?? request.sessionId)
      && !this.switching;
  }

  /** Commit a visible thread after bootstrap or a same-thread detail refresh. */
  activateSession(sessionId: string): void {
    if (this.bootstrapped && !this.switching && this.activeSessionId === sessionId) return;
    this.generation += 1;
    this.activeSessionId = sessionId;
    this.pendingSessionId = undefined;
    this.switching = false;
    this.bootstrapped = true;
  }

  isActiveSession(sessionId: string): boolean {
    return !this.switching && this.activeSessionId === sessionId;
  }

  get isSwitching(): boolean { return this.switching; }
}
