import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import { isHostTranscriptCursor } from "../shared/transcript-cursor";
import type { TranscriptCursorBoundary } from "../shared/transcript-contract";
import { messageIdToRawIndexProjection, projectRawIndexesByMessageId } from "../shared/transcript-indexes";
import { INITIAL_TRANSCRIPT_TURN_LIMIT, transcriptPageBounds } from "../shared/transcript-pager";

const CACHE_KEY = "tau.bootstrap-cache.v5";
const LEGACY_CACHE_KEYS = ["tau.bootstrap-cache.v4", "tau.bootstrap-cache.v3"] as const;
const MAX_BYTES = 512 * 1024;

export interface CachedBootstrap {
  snapshot: HostSnapshot;
  threadIndex: ThreadIndexSnapshot;
}

function boundedSnapshot(snapshot: HostSnapshot): HostSnapshot {
  const bounds = transcriptPageBounds(snapshot.messages, INITIAL_TRANSCRIPT_TURN_LIMIT);
  const messages = snapshot.messages.slice(bounds.start, bounds.end);
  const sourceIndexes = messageIdToRawIndexProjection(snapshot.messages, snapshot.transcriptMessageIndexes);
  const retainedIndexes = projectRawIndexesByMessageId(messages, sourceIndexes);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const firstRetainedMessageId = firstUserMessage?.id ?? messages[0]?.id;
  const boundaries = (snapshot.cursorBoundaries ?? []).filter((boundary): boundary is TranscriptCursorBoundary =>
    typeof boundary?.messageId === "string" && isHostTranscriptCursor(boundary.cursor));
  const directBoundary = snapshot.cursorBeforeMessageId && isHostTranscriptCursor(snapshot.olderCursor)
    ? { messageId: snapshot.cursorBeforeMessageId, cursor: snapshot.olderCursor }
    : undefined;
  const selectedBoundary = boundaries.find((boundary) => boundary.messageId === firstRetainedMessageId)
    ?? (directBoundary?.messageId === firstRetainedMessageId ? directBoundary : undefined);
  const historyCompleteness = selectedBoundary || snapshot.historyCompleteness === "legacy-truncated" || snapshot.historyCompleteness === "unknown"
    ? snapshot.historyCompleteness
    : snapshot.olderCursor === undefined
      ? snapshot.historyCompleteness
      : "unknown";
  return {
    ...snapshot,
    messages,
    taskHistory: snapshot.taskHistory?.filter((entry) => !entry.anchorMessageId || messages.some((message) => message.id === entry.anchorMessageId)),
    historyCompleteness,
    ...(selectedBoundary ? {
      olderCursor: selectedBoundary.cursor,
      cursorBeforeMessageId: selectedBoundary.messageId,
      cursorBoundaries: [selectedBoundary],
    } : {
      olderCursor: undefined,
      cursorBeforeMessageId: undefined,
      cursorBoundaries: undefined,
    }),
    ...(retainedIndexes
      ? { transcriptMessageIndexes: retainedIndexes }
      : { transcriptMessageIndexes: undefined }),
    models: [],
    allTools: [],
    activeTools: [],
    isStreaming: false,
  };
}

export function readBootstrapCache(storage: Pick<Storage, "getItem"> = localStorage): CachedBootstrap | undefined {
  try {
    const raw = [storage.getItem(CACHE_KEY), ...LEGACY_CACHE_KEYS.map((key) => storage.getItem(key))].find(Boolean);
    if (!raw || raw.length > MAX_BYTES) return undefined;
    const value = JSON.parse(raw) as CachedBootstrap;
    if (!value?.snapshot?.sessionId || !Array.isArray(value.snapshot.messages) || !Array.isArray(value.threadIndex?.sessions)) return undefined;
    // Normalize records written by an older renderer before exposing them to
    // the first paint. The v3 key prevents normal reads of the old shape, while
    // this guard also protects tests/imported caches with stale contents.
    return { snapshot: boundedSnapshot(value.snapshot), threadIndex: value.threadIndex };
  } catch {
    return undefined;
  }
}

export function writeBootstrapCache(
  snapshot: HostSnapshot | undefined,
  threadIndex: ThreadIndexSnapshot | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
  if (!snapshot || !threadIndex) return;
  try {
    const raw = JSON.stringify({ snapshot: boundedSnapshot(snapshot), threadIndex } satisfies CachedBootstrap);
    if (raw.length > MAX_BYTES) { storage.removeItem(CACHE_KEY); return; }
    storage.setItem(CACHE_KEY, raw);
  } catch {
    // A cache miss is safe. Quota or privacy errors must not block the workbench.
  }
}
