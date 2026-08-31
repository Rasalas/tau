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
  const limited = historyCompleteness === "legacy-truncated" || historyCompleteness === "unknown";
  const message = loading
    ? "Loading older turns…"
    : status?.state === "error"
      ? status.message ?? "Could not load older turns."
      : limited
        ? historyCompleteness === "legacy-truncated"
          ? "Older history cannot be loaded with this Pi bridge. Upgrade the bridge to load it."
          : "Older history availability cannot be determined with this bridge. An updated bridge may enable loading older turns."
      : status?.state === "success"
        ? `${loadedLabel(status.loadedTurns)}${hasOlder ? "" : " Beginning of history."}`
        : hasOlder
          ? "Older turns are available."
          : "Beginning of history.";

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
