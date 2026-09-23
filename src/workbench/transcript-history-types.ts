import type { HostSnapshot, UiMessage } from "../shared/contracts.js";
import type { TranscriptHistoryCompleteness } from "../shared/transcript-completeness.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol.js";

declare const transitionTokenBrand: unique symbol;

/** Generation token that authorizes one visible-thread transition. */
export type TransitionToken = number & { readonly [transitionTokenBrand]: true };

export interface TranscriptHistoryStatus {
  state: "success" | "error";
  message?: string;
  loadedTurns?: number;
}

export interface TranscriptHistoryState {
  sessionId?: string;
  olderCursor?: HostTranscriptCursor;
  historyCompleteness?: TranscriptHistoryCompleteness;
  loading: boolean;
  status?: TranscriptHistoryStatus;
}

export interface TranscriptHistoryRequest {
  generation: number;
  sessionId: string;
  cursor: HostTranscriptCursor;
}

export interface TranscriptBootstrapRequest {
  generation: number;
}

export interface TranscriptScrollAnchor {
  messageId: string;
  viewportOffset: number;
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

export type { ThreadDetail, TranscriptPage };
