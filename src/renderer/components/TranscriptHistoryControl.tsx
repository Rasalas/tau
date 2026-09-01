import type { TranscriptHistoryStatus } from "../transcript-history";
import type { TranscriptHistoryCompleteness } from "../../shared/transcript-completeness";
import type { HostTranscriptCursor } from "../../shared/transcript-cursor";

export type { TranscriptHistoryStatus } from "../transcript-history";

export interface TranscriptHistoryControlProps {
  olderCursor?: HostTranscriptCursor;
  historyCompleteness?: TranscriptHistoryCompleteness;
  loading: boolean;
  status?: TranscriptHistoryStatus;
  onLoad: () => void;
}

function loadedLabel(count: number | undefined): string {
  if (count === undefined) return "Older turns loaded.";
  return `${count} older ${count === 1 ? "turn" : "turns"} loaded.`;
}

/** The explicit boundary control for bounded transcript history. */
export function TranscriptHistoryControl({
  olderCursor,
  historyCompleteness,
  loading,
  status,
  onLoad,
}: TranscriptHistoryControlProps) {
  const hasOlder = Boolean(olderCursor);
  const limited = historyCompleteness === "unknown";
  if ((!hasOlder || limited) && !loading && status?.state !== "error") return null;
  const message = loading
    ? "Loading older turns…"
    : status?.state === "error"
      ? status.message ?? "Could not load older turns."
      : status?.state === "success"
        ? loadedLabel(status.loadedTurns)
        : "Older turns are available.";

  return <section
    className={`transcript-history-control${loading ? " loading" : ""}${status?.state === "error" ? " error" : ""}${limited ? " limited" : ""}`}
    aria-label="Transcript history"
    aria-busy={loading}
  >
    <span role="status" aria-live="polite" aria-atomic="true">{message}</span>
    {hasOlder && !limited ? (
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        aria-label={loading ? "Loading older turns" : status?.state === "error" ? "Retry loading older turns" : "Load older turns"}
      >
        {loading ? "Loading…" : status?.state === "error" ? "Retry" : "Load older turns"}
      </button>
    ) : null}
  </section>;
}
