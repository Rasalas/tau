import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import { detailFromSnapshot } from "../shared/host-protocol";
import { INITIAL_TRANSCRIPT_TURN_LIMIT } from "../shared/transcript-pager";

const CACHE_KEY = "tau.bootstrap-cache.v1";
const MAX_BYTES = 512 * 1024;

export interface CachedBootstrap {
  snapshot: HostSnapshot;
  threadIndex: ThreadIndexSnapshot;
}

function boundedSnapshot(snapshot: HostSnapshot): HostSnapshot {
  const detail = detailFromSnapshot(snapshot, INITIAL_TRANSCRIPT_TURN_LIMIT);
  const sourceIndexes = snapshot.transcriptMessageIndexes
    ? new Map(snapshot.messages.map((message, index) => [message.id, snapshot.transcriptMessageIndexes?.[index]] as const))
    : undefined;
  const retainedIndexes = sourceIndexes
    ? detail.messages.map((message) => sourceIndexes.get(message.id))
    : undefined;
  const firstRetainedIndex = detail.messages.length > 0
    ? snapshot.messages.findIndex((message) => message.id === detail.messages[0]?.id)
    : -1;
  const mappedCursor = retainedIndexes?.[0];
  const existingCursor = snapshot.olderCursor === undefined ? undefined : Number(snapshot.olderCursor);
  const boundedCursor = mappedCursor !== undefined
    ? mappedCursor > 0 ? String(mappedCursor) : undefined
    : firstRetainedIndex >= 0 && existingCursor !== undefined && Number.isSafeInteger(existingCursor) && existingCursor >= 0
      ? String(existingCursor + firstRetainedIndex)
      : detail.olderCursor;
  return {
    ...snapshot,
    messages: detail.messages,
    ...(boundedCursor ? { olderCursor: boundedCursor } : { olderCursor: undefined }),
    ...(retainedIndexes?.every((index): index is number => index !== undefined)
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
    if (!value?.snapshot?.sessionId || !Array.isArray(value.threadIndex?.sessions)) return undefined;
    return value;
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
