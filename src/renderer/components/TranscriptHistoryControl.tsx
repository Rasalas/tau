import type { TranscriptHistoryStatus } from "../../workbench/transcript-history";
import type { TranscriptHistoryCompleteness } from "../../shared/transcript-completeness";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";

export type { TranscriptHistoryStatus } from "../../workbench/transcript-history";

export interface TranscriptHistoryControlProps {
  olderCursor?: HostTranscriptCursor;
  historyCompleteness?: TranscriptHistoryCompleteness;
  loading: boolean;
  status?: TranscriptHistoryStatus;
  onRetry: () => void;
}

/** What the reader and probes see of the older turns, on the element above the first loaded row. */
export type OlderTurnsState = "available" | "loading" | "error";

/**
 * The start of the loaded transcript. Older turns load as the reader scrolls
 * toward it, so it stays empty while they wait; it shows a quiet line while
 * they load or after a page failed, and nothing at the thread's real start.
 */
export function TranscriptHistoryControl({
  olderCursor,
  historyCompleteness,
  loading,
  status,
  onRetry,
}: TranscriptHistoryControlProps) {
  const failed = !loading && status?.state === "error";
  const more = Boolean(olderCursor) && historyCompleteness !== "unknown";
  if (!more && !loading && !failed) return null;
  const state: OlderTurnsState = loading ? "loading" : failed ? "error" : "available";
  const message = failed ? status?.message ?? "Could not load older turns." : "Loading older turns…";

  return <div className="transcript-history" data-older-turns={state}>
    {state === "available" ? null : <div className={`transcript-history-row ${state}`} role="status" aria-live="polite">
      {state === "loading" ? <span className="transcript-history-spinner" aria-hidden="true" /> : null}
      <span className="transcript-history-message" title={failed ? message : undefined}>{message}</span>
      {failed && olderCursor ? <button type="button" onClick={onRetry} aria-label="Retry loading older turns">Retry</button> : null}
    </div>}
  </div>;
}
