import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import { detailFromSnapshot } from "../shared/host-protocol";
import { localTranscriptCursorAt, rawBridgeTranscriptCursorAt, transcriptCursorValue, type TranscriptCursor } from "../shared/transcript-cursor";
import { messageIdToRawIndexProjection, projectRawIndexesByMessageId } from "../shared/transcript-indexes";
import { INITIAL_TRANSCRIPT_TURN_LIMIT } from "../shared/transcript-pager";

const CACHE_KEY = "tau.bootstrap-cache.v3";
const MAX_BYTES = 512 * 1024;

export interface CachedBootstrap {
  snapshot: HostSnapshot;
  threadIndex: ThreadIndexSnapshot;
}

function boundedSnapshot(snapshot: HostSnapshot): HostSnapshot {
  const detail = detailFromSnapshot(snapshot, INITIAL_TRANSCRIPT_TURN_LIMIT);
  const sourceIndexes = messageIdToRawIndexProjection(snapshot.messages, snapshot.transcriptMessageIndexes);
  const retainedIndexes = projectRawIndexesByMessageId(detail.messages, sourceIndexes);
  const firstRetainedIndex = detail.messages.length > 0
    ? snapshot.messages.findIndex((message) => message.id === detail.messages[0]?.id)
    : -1;
  const mappedCursor = retainedIndexes?.[0];
  const existingCursor = snapshot.olderCursor === undefined
    ? undefined
    : Number(transcriptCursorValue(snapshot.olderCursor));
  const cursorAtOrigin = (index: number): TranscriptCursor => snapshot.olderCursor?.kind === "bridge"
    ? rawBridgeTranscriptCursorAt(index)
    : localTranscriptCursorAt(index);
  const boundedCursor = mappedCursor !== undefined
    ? detail.olderCursor !== undefined && mappedCursor > 0 ? cursorAtOrigin(mappedCursor) : undefined
    : firstRetainedIndex >= 0 && existingCursor !== undefined && Number.isSafeInteger(existingCursor) && existingCursor >= 0
      && detail.olderCursor !== undefined ? cursorAtOrigin(existingCursor + firstRetainedIndex)
      : detail.olderCursor;
  return {
    ...snapshot,
    messages: detail.messages,
    taskHistory: detail.taskHistory,
    historyCompleteness: detail.historyCompleteness,
    ...(boundedCursor ? { olderCursor: boundedCursor } : { olderCursor: undefined }),
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
    const raw = storage.getItem(CACHE_KEY);
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
