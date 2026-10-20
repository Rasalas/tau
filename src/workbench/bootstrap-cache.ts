import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts.js";
import { isHostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { TranscriptCursorBoundary } from "../shared/transcript-contract.js";
import { normalizeTranscriptCursorBoundaries, turnActivityHistoryForMessages } from "../shared/host-protocol.js";
import { parseTranscriptHistoryCompleteness } from "../shared/transcript-completeness.js";
import { INITIAL_TRANSCRIPT_TURN_LIMIT, transcriptPageBounds } from "../shared/transcript-pager.js";
import { getClientStorage, type ClientStorage } from "./client-storage.js";
import { STORAGE_KEYS } from "./storage-keys.js";

const CACHE_KEY = STORAGE_KEYS.bootstrapCache;
const LEGACY_CACHE_KEYS = STORAGE_KEYS.bootstrapCacheLegacy;
const MAX_BYTES = 512 * 1024;
const MAX_INDEX_SESSIONS = 1_000;
const byteLength = (raw: string) => new TextEncoder().encode(raw).length;

export interface CachedBootstrap {
  snapshot: HostSnapshot;
  threadIndex: ThreadIndexSnapshot;
  savedAt?: number;
}

function boundedSnapshot(snapshot: HostSnapshot): HostSnapshot {
  const bounds = transcriptPageBounds(snapshot.messages, INITIAL_TRANSCRIPT_TURN_LIMIT);
  const messages = snapshot.messages.slice(bounds.start, bounds.end);
  const wasTrimmed = messages.length < snapshot.messages.length;
  const firstUserMessage = messages.find((message) => message.role === "user");
  const firstRetainedMessageId = firstUserMessage?.id ?? messages[0]?.id;
  const boundaries = normalizeTranscriptCursorBoundaries(
    (snapshot.cursorBoundaries ?? []).filter((boundary): boundary is TranscriptCursorBoundary =>
      typeof boundary?.messageId === "string" && isHostTranscriptCursor(boundary.cursor)),
    snapshot.cursorBeforeMessageId,
    isHostTranscriptCursor(snapshot.olderCursor) ? snapshot.olderCursor : undefined,
  );
  const selectedBoundary = boundaries?.find((boundary) => boundary.messageId === firstRetainedMessageId)
    ?? undefined;
  // Older records can contain unknown string values and provider cursor
  // objects. Normalize both before deciding whether the retained window is
  // pageable; `has-more` without a usable boundary would falsely advertise a
  // load action or allow the UI to call the retained window complete.
  const rawHistoryCompleteness = (snapshot as { historyCompleteness?: unknown }).historyCompleteness;
  const sourceCompleteness = parseTranscriptHistoryCompleteness(rawHistoryCompleteness)
    ?? (rawHistoryCompleteness === undefined ? undefined : "unknown");
  const historyCompleteness = sourceCompleteness === "unknown"
    ? sourceCompleteness
    : sourceCompleteness === "has-more" && !selectedBoundary
      ? "unknown"
      : selectedBoundary
        ? "has-more"
        : wasTrimmed
          ? "unknown"
          : sourceCompleteness ?? "complete";
  return {
    ...snapshot,
    messages,
    taskHistory: snapshot.taskHistory?.filter((entry) => !entry.anchorMessageId || messages.some((message) => message.id === entry.anchorMessageId)),
    turnActivityHistory: turnActivityHistoryForMessages(snapshot.turnActivityHistory, messages),
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
    models: [],
    allTools: [],
    activeTools: [],
    isStreaming: false,
  };
}

export function readBootstrapCache(storage: ClientStorage | undefined = getClientStorage()): CachedBootstrap | undefined {
  try {
    if (!storage) return undefined;
    const raw = [storage.get(CACHE_KEY), ...LEGACY_CACHE_KEYS.map((key) => storage.get(key))].find(Boolean);
    if (!raw || byteLength(raw) > MAX_BYTES) return undefined;
    const value = JSON.parse(raw) as CachedBootstrap;
    if (!value?.snapshot?.sessionId || !Array.isArray(value.snapshot.messages) || !Array.isArray(value.threadIndex?.sessions)) return undefined;
    // Normalize records written by an older renderer before exposing them to
    // the first paint. The versioned key separates the opaque-boundary shape;
    // this guard also protects tests/imported caches with stale contents.
    return { snapshot: boundedSnapshot(value.snapshot), threadIndex: value.threadIndex, savedAt: typeof value.savedAt === "number" ? value.savedAt : undefined };
  } catch {
    return undefined;
  }
}

export function writeBootstrapCache(
  snapshot: HostSnapshot | undefined,
  threadIndex: ThreadIndexSnapshot | undefined,
  storage: ClientStorage | undefined = getClientStorage(),
): void {
  if (!snapshot || !threadIndex || !storage) return;
  const pending = pendingWrites.get(storage);
  if (pending) { clearTimeout(pending.timer); pendingWrites.delete(storage); }
  try {
    // Runs are the host's word at bootstrap time; a cold start must not replay stale ones.
    const { runs: _runs, ...sourceIndex } = threadIndex;
    const index = { ...sourceIndex, projects: sourceIndex.projects.slice(0, 100) };
    let retained = boundedSnapshot(snapshot);
    let sessions = index.sessions.slice(0, MAX_INDEX_SESSIONS);
    const active = index.sessions.find((thread) => thread.id === snapshot.sessionId);
    if (active && !sessions.some((thread) => thread.id === active.id)) sessions = [active, ...sessions.slice(0, -1)];
    const savedAt = Date.now();
    const serialize = () => JSON.stringify({ snapshot: retained, threadIndex: { ...index, sessions }, savedAt } satisfies CachedBootstrap);
    let raw = serialize();
    // Shrink the index independently before giving up any of the active chat.
    while (byteLength(raw) > MAX_BYTES && sessions.length > (active ? 1 : 0)) {
      sessions = sessions.slice(0, Math.floor(sessions.length / 2));
      if (active && !sessions.some((thread) => thread.id === active.id)) sessions.unshift(active);
      raw = serialize();
    }
    if (byteLength(raw) > MAX_BYTES && retained.messages.length) {
      // The fewest oldest messages to drop, found by halving: one serialization
      // per step instead of one per dropped message.
      const window = retained;
      const without = (count: number) => boundedSnapshot({ ...window, messages: window.messages.slice(count), historyCompleteness: "unknown" });
      let low = 1;
      let high = window.messages.length;
      let fitting: string | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        retained = without(count);
        const candidate = serialize();
        if (byteLength(candidate) <= MAX_BYTES) {
          fitting = candidate;
          high = count - 1;
        } else low = count + 1;
      }
      if (fitting === undefined) return;
      raw = fitting;
    }
    if (byteLength(raw) <= MAX_BYTES) storage.set(CACHE_KEY, raw);
  } catch {
    // A cache miss is safe. Quota or privacy errors must not block the workbench.
  }
}

// Coalesce high-frequency host updates; explicit writes remain synchronous for callers
// that need a durable checkpoint. The renderer flushes pending writes on pagehide.
const pendingWrites = new Map<ClientStorage, { snapshot: HostSnapshot; index: ThreadIndexSnapshot; timer: ReturnType<typeof setTimeout> }>();
export function scheduleBootstrapCache(snapshot: HostSnapshot | undefined, index: ThreadIndexSnapshot | undefined, storage: ClientStorage | undefined): void {
  if (!snapshot || !index || !storage) return;
  const pending = pendingWrites.get(storage);
  if (pending) { pending.snapshot = snapshot; pending.index = index; return; }
  const timer = setTimeout(() => flushBootstrapCache(storage), 250);
  pendingWrites.set(storage, { snapshot, index, timer });
}
export function flushBootstrapCache(storage: ClientStorage): void {
  const pending = pendingWrites.get(storage);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingWrites.delete(storage);
  writeBootstrapCache(pending.snapshot, pending.index, storage);
}
