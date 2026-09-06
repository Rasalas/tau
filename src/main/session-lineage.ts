import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { AGENT_PARENT_ENTRY } from "../shared/agents-kit-protocol.js";
import { type PersistedJsonLogger, readPersistedJson, writePersistedJson } from "./persisted-json.js";
import type { SessionFileStamp } from "./session-usage.js";

/**
 * Which thread spawned the thread a session file holds, read from the file
 * itself rather than from the kit that made the link.
 *
 * A spawned thread carries the link as the first entry after its header, so
 * two lines answer the question. Pi's own header field for this
 * (`parentSession`) is a path and is already spent: `/new` chains and
 * `createBranchedSession` both set it, and Tau forks through the latter, so
 * hiding by it would hide every forked thread from the rail.
 */

/** Bump this when the marker moves or changes shape; an older cache rescans whole files once. */
const CACHE_VERSION = 1;

const SAVE_DELAY_MS = 2_000;

/** Session files read at once when the cache misses; matches the index's own provider reads. */
const CONCURRENCY = 10;

/** The custom entry a spawned thread's session carries; the kit that spawns owns the name. */
export const PARENT_LINK_ENTRY = AGENT_PARENT_ENTRY;

/** The link data a spawned thread's session carries. */
export function parentLinkEntry(parentThreadId: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, ...details, parentThreadId };
}

function parentThreadIdOf(line: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== AGENT_PARENT_ENTRY) return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  const parent = (data as { parentThreadId?: unknown }).parentThreadId;
  return typeof parent === "string" && parent ? parent : undefined;
}

/** The same link as `readSessionParent`, for entries the host already holds in memory. */
export function parentThreadIdFromEntries(entries: Iterable<unknown>): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== AGENT_PARENT_ENTRY) continue;
    const parent = (item.data as { parentThreadId?: unknown } | undefined)?.parentThreadId;
    if (typeof parent === "string" && parent) return parent;
  }
  return undefined;
}

/**
 * The thread that spawned this session, or undefined. Reads the header and the
 * line after it; `deep` keeps reading, which is what finds a child written
 * before the link moved to the front of the file.
 */
export async function readSessionParent(path: string, options: { deep?: boolean } = {}): Promise<string | undefined> {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0;
    for await (const line of lines) {
      index += 1;
      if (index === 1) continue;
      if (line.includes(AGENT_PARENT_ENTRY)) {
        const parent = parentThreadIdOf(line);
        if (parent) return parent;
      }
      if (!options.deep) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    stream.destroy();
  }
  return undefined;
}

interface CacheEntry extends SessionFileStamp {
  path: string;
  parentThreadId?: string;
}

function decodeEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || typeof candidate.size !== "number" || typeof candidate.mtimeMs !== "number") return undefined;
  return {
    path: candidate.path,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    ...(typeof candidate.parentThreadId === "string" ? { parentThreadId: candidate.parentThreadId } : {}),
  };
}

export interface SessionLineageIndexOptions {
  /** Where the cache is persisted; without one it lives only for this process. */
  path?: string;
  logger?: PersistedJsonLogger;
  concurrency?: number;
}

/**
 * Who spawned each indexed thread, keyed by session file plus size and mtime.
 * A thread's parent never changes, so a file that once answered is never read
 * again; every other file costs the two lines the link sits on.
 *
 * A cache this build did not write - none at all, or one from before the
 * marker moved to the front - makes the first pass of this run read whole
 * files, so children created by an older build are found once and then cached
 * like the rest.
 */
export class SessionLineageIndex {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly options: SessionLineageIndexOptions;
  /** Until the first pass of a run this build did not seed has finished. */
  private migrating = true;
  private dirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private disposed = false;

  constructor(options: SessionLineageIndexOptions = {}) {
    this.options = options;
  }

  async load(): Promise<void> {
    if (!this.options.path) return;
    const read = await readPersistedJson<CacheEntry[]>(this.options.path, {
      expectedVersion: CACHE_VERSION,
      decode: (value, version) => {
        if (version !== CACHE_VERSION) return undefined;
        const list = (value as { entries?: unknown })?.entries;
        return Array.isArray(list) ? list.flatMap((item) => decodeEntry(item) ?? []) : undefined;
      },
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
    if (!read) return;
    for (const entry of read.data) this.entries.set(entry.path, entry);
    this.migrating = false;
  }

  /** True while this run still reads whole files to find links an older build wrote. */
  get isMigrating(): boolean {
    return this.migrating;
  }

  /**
   * The parent of every listed session, by session file. Cached answers cost
   * nothing; the rest are read with the index's own concurrency and cached
   * under the stamp they were read at.
   */
  async resolve(files: readonly { path: string; stamp?: SessionFileStamp }[]): Promise<Map<string, string>> {
    const deep = this.migrating;
    const pending = files.filter((file) => this.cached(file.path, file.stamp) === undefined);
    const width = Math.min(Math.max(1, this.options.concurrency ?? CONCURRENCY), Math.max(1, pending.length));
    const read = async (index: number): Promise<void> => {
      const file = pending[index];
      if (!file || this.disposed) return;
      const parentThreadId = await readSessionParent(file.path, { deep });
      if (file.stamp) {
        this.entries.set(file.path, { path: file.path, ...file.stamp, ...(parentThreadId ? { parentThreadId } : {}) });
        this.markDirty();
      }
      await read(index + width);
    };
    if (pending.length > 0) await Promise.all(Array.from({ length: width }, (_, index) => read(index)));
    // Every file this run listed has been read to the end; later passes only
    // need the two lines a link sits on.
    if (deep) { this.migrating = false; this.markDirty(); }
    const parents = new Map<string, string>();
    for (const file of files) {
      const parent = this.entries.get(file.path)?.parentThreadId;
      if (parent) parents.set(file.path, parent);
    }
    return parents;
  }

  /** A link the host wrote itself; the child's file may not exist yet. */
  record(path: string, stamp: SessionFileStamp | undefined, parentThreadId: string): void {
    const existing = this.entries.get(path);
    if (existing?.parentThreadId === parentThreadId && (!stamp || (existing.size === stamp.size && existing.mtimeMs === stamp.mtimeMs))) return;
    this.entries.set(path, { path, size: stamp?.size ?? -1, mtimeMs: stamp?.mtimeMs ?? -1, parentThreadId });
    this.markDirty();
  }

  /** Forgets sessions the last scan no longer listed, so the cache tracks the index. */
  retain(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const path of [...this.entries.keys()]) {
      if (keep.has(path)) continue;
      this.entries.delete(path);
      this.markDirty();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    await this.saving;
    if (!this.dirty || !this.options.path) return;
    this.dirty = false;
    this.saving = writePersistedJson(this.options.path, CACHE_VERSION, { entries: [...this.entries.values()] }, {
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    }).catch(() => { this.dirty = true; });
    await this.saving;
  }

  /**
   * A known parent answers whatever the file looks like now: a thread's parent
   * never changes. Anything else is only trusted while the stamp still matches.
   */
  private cached(path: string, stamp: SessionFileStamp | undefined): string | null | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (entry.parentThreadId) return entry.parentThreadId;
    if (!stamp) return null;
    return entry.size === stamp.size && entry.mtimeMs === stamp.mtimeMs ? null : undefined;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.options.path || this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }
}
