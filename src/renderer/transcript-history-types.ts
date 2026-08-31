import type { HostSnapshot, UiMessage } from "../shared/contracts";
import type { TranscriptHistoryCompleteness } from "../shared/transcript-completeness";
import type { LocalTranscriptCursor } from "../shared/transcript-cursor";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";

export interface TranscriptHistoryStatus {
  state: "success" | "error";
  message?: string;
  loadedTurns?: number;
}

export interface TranscriptHistoryState {
  sessionId?: string;
  olderCursor?: LocalTranscriptCursor;
  historyCompleteness?: TranscriptHistoryCompleteness;
  loading: boolean;
  status?: TranscriptHistoryStatus;
}

export interface TranscriptHistoryRequest {
  generation: number;
  sessionId: string;
  cursor: LocalTranscriptCursor;
}

export interface TranscriptBootstrapRequest {
  generation: number;
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

export type { ThreadDetail, TranscriptPage };
