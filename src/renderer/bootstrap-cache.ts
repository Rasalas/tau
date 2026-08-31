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
  return {
    ...snapshot,
    messages: detail.messages,
    ...(snapshot.olderCursor || detail.olderCursor
      ? { olderCursor: snapshot.olderCursor ?? detail.olderCursor }
      : {}),
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
