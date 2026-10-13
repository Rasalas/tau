import type { UiToolRun } from "../shared/contracts";
import type { UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";

export interface CachedTurnActivity {
  sessionId: string;
  /** Kept for older caches; Workspace Kit stores its own baseline now. */
  baseline?: UiWorkspaceChanges;
  tools: UiToolRun[];
  anchorMessageId?: string;
}

interface Cache {
  entries: Map<string, CachedTurnActivity>;
  dirty: Set<string>;
  revision: number;
}

interface StoredTurnActivity {
  activity: CachedTurnActivity;
  revision: number;
}

const caches = new WeakMap<ClientStorage, Cache>();
const PREFIX = `${STORAGE_KEYS.threadTurnActivity}:`;
const keyOf = (sessionId: string) => `${PREFIX}${encodeURIComponent(sessionId)}`;

function boundedTools(tools: UiToolRun[]): UiToolRun[] {
  return tools.slice(-200).map((tool) => ({
    ...tool,
    output: tool.output && tool.output.length > 8_192
      ? `${tool.output.slice(0, 8_192)}\n[Cached output truncated]`
      : tool.output,
  }));
}

function load(storage: ClientStorage): Cache {
  const existing = caches.get(storage);
  if (existing) return existing;
  const cache: Cache = { entries: new Map(), dirty: new Set(), revision: 0 };
  caches.set(storage, cache);
  let legacy: string | null = null;
  try {
    legacy = storage.get(STORAGE_KEYS.turnActivityCache);
    for (const [id, entry] of Object.entries(JSON.parse(legacy ?? "{}") as Record<string, CachedTurnActivity>)) {
      if (entry?.sessionId === id && Array.isArray(entry.tools)) cache.entries.set(id, entry);
    }
  } catch { /* A damaged cache is disposable. */ }
  try {
    const stored: StoredTurnActivity[] = [];
    for (const key of storage.keys(PREFIX)) {
      try {
        const entry = JSON.parse(storage.get(key) ?? "null") as StoredTurnActivity | null;
        if (entry?.activity && typeof entry.activity.sessionId === "string" && Array.isArray(entry.activity.tools)
          && Number.isSafeInteger(entry.revision) && keyOf(entry.activity.sessionId) === key) stored.push(entry);
      } catch { /* Keep other threads when one entry is damaged. */ }
    }
    for (const { activity, revision } of stored.sort((a, b) => a.revision - b.revision)) {
      cache.entries.delete(activity.sessionId);
      cache.entries.set(activity.sessionId, activity);
      cache.revision = Math.max(cache.revision, revision);
    }
  } catch { /* Storage may be blocked. */ }
  prune(storage, cache);
  if (legacy !== null) {
    try {
      // Release the old blob's quota before migrating its bounded entries once.
      storage.remove(STORAGE_KEYS.turnActivityCache);
      for (const entry of cache.entries.values()) cache.dirty.add(entry.sessionId);
      flushCachedTurnActivity(storage);
    } catch { /* The in-memory cache still restores the legacy turn. */ }
  }
  return cache;
}

function prune(storage: ClientStorage, cache: Cache): void {
  while (cache.entries.size > 12) {
    const id = cache.entries.keys().next().value!;
    cache.entries.delete(id);
    cache.dirty.delete(id);
    try { storage.remove(keyOf(id)); } catch { /* A blocked store must not break the transcript. */ }
  }
}

export function readCachedTurnActivity(storage: ClientStorage, sessionId: string): CachedTurnActivity | undefined {
  return load(storage).entries.get(sessionId);
}

/** Holds the latest state without parsing or serializing storage on a tool flush. */
export function cacheTurnActivity(storage: ClientStorage, activity: CachedTurnActivity): void {
  const cache = load(storage);
  cache.entries.delete(activity.sessionId);
  cache.entries.set(activity.sessionId, { ...activity, tools: activity.tools.slice(-200) });
  cache.dirty.add(activity.sessionId);
  prune(storage, cache);
}

export function flushCachedTurnActivity(storage: ClientStorage): void {
  const cache = load(storage);
  for (const id of cache.dirty) {
    cache.dirty.delete(id);
    const entry = cache.entries.get(id);
    if (!entry) continue;
    const bounded = { ...entry, tools: boundedTools(entry.tools) };
    cache.entries.set(id, bounded);
    cache.revision += 1;
    try {
      storage.set(keyOf(id), JSON.stringify({ activity: bounded, revision: cache.revision } satisfies StoredTurnActivity));
    } catch { /* A full store must not break the transcript. */ }
  }
}

export function writeCachedTurnActivity(storage: ClientStorage, activity: CachedTurnActivity): void {
  cacheTurnActivity(storage, activity);
  flushCachedTurnActivity(storage);
}

/** Drops pending work too, so a deferred write cannot resurrect a dead run. */
export function clearCachedTurnActivity(storage: ClientStorage, sessionId: string): void {
  const cache = load(storage);
  cache.entries.delete(sessionId);
  cache.dirty.delete(sessionId);
  try { storage.remove(keyOf(sessionId)); } catch { /* A blocked store must not break recovery. */ }
}
