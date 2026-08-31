/**
 * The renderer must distinguish a known end from a bounded or incompatible
 * source. A missing cursor alone is not enough to claim complete history.
 */
export type TranscriptHistoryCompleteness =
  | "complete"
  | "has-more"
  | "legacy-truncated"
  | "unknown";

/** The legacy Pi bridge snapshot keeps at most this many raw records. */
export const LEGACY_BRIDGE_SNAPSHOT_RECORD_LIMIT = 160 as const;

export function parseTranscriptHistoryCompleteness(value: unknown): TranscriptHistoryCompleteness | undefined {
  return value === "complete" || value === "has-more" || value === "legacy-truncated" || value === "unknown"
    ? value
    : undefined;
}

/**
 * Check the cursor/flag/completeness tuple as one protocol value. A page is
 * actionable only when its three pieces agree; accepting them independently
 * lets a malformed preload update silently turn a bounded window into a false
 * end (or make a load impossible by claiming more without a cursor).
 */
export function isTranscriptHistoryMetadataConsistent(input: {
  hasMore: unknown;
  hasCursor: boolean;
  historyCompleteness: unknown;
  requireHasMore: boolean;
}): boolean {
  const { hasMore, hasCursor, historyCompleteness, requireHasMore } = input;
  if (requireHasMore && typeof hasMore !== "boolean") return false;
  if (hasMore !== undefined && typeof hasMore !== "boolean") return false;
  if (typeof hasMore === "boolean" && hasMore !== hasCursor) return false;

  const parsed = historyCompleteness === undefined
    ? undefined
    : parseTranscriptHistoryCompleteness(historyCompleteness);
  if (historyCompleteness !== undefined && parsed === undefined) return false;
  if (parsed === "complete") return !hasMore && !hasCursor;
  if (parsed === "has-more") return hasMore === true && hasCursor;
  if (parsed === "legacy-truncated" || parsed === "unknown") return !hasMore && !hasCursor;
  return true;
}

/** Resolve a page/window state without allowing an absent cursor to overclaim. */
export function resolveTranscriptHistoryCompleteness(
  value: unknown,
  hasMore: boolean,
  fallback: TranscriptHistoryCompleteness = "complete",
): TranscriptHistoryCompleteness {
  if (hasMore) return "has-more";
  const parsed = parseTranscriptHistoryCompleteness(value);
  if (parsed === "legacy-truncated" || parsed === "unknown") return parsed;
  // A has-more claim without a cursor cannot be acted on safely. Keep it
  // visibly limited instead of allowing a malformed peer to imply an end.
  if (parsed === "has-more") return "unknown";
  return parsed === "complete" ? "complete" : fallback === "has-more" ? "unknown" : fallback;
}

/** Infer the safest state for a snapshot from an older bridge without metadata. */
export function inferLegacyBridgeCompleteness(
  messageCount: number,
  negotiatedPaging: boolean,
  explicit?: unknown,
  hasMore = false,
): TranscriptHistoryCompleteness {
  const parsed = parseTranscriptHistoryCompleteness(explicit);
  if (negotiatedPaging) {
    if (parsed) return resolveTranscriptHistoryCompleteness(parsed, hasMore, parsed);
    return hasMore ? "has-more" : "complete";
  }
  // A no-capability peer still speaks the legacy bounded shape. Do not let an
  // optional field from that peer turn an ambiguous window into a false end;
  // only explicit limited states are safe to carry across the legacy seam.
  if (parsed === "legacy-truncated" || parsed === "unknown") return parsed;
  return messageCount >= LEGACY_BRIDGE_SNAPSHOT_RECORD_LIMIT ? "legacy-truncated" : "unknown";
}
