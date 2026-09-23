import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { UiThreadUsage } from "../shared/contracts.js";
import { emptyTally, readUsageTally, type UsageTally } from "./usage-pricing.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/** Identity of a session file's contents, cheap enough to take on every scan. */
export interface SessionFileStamp {
  size: number;
  mtimeMs: number;
}

// 2: tallies per provider and model instead of one priced total.
const CACHE_VERSION = 2;
const SAVE_DELAY_MS = 2_000;
/**
 * Session files read per scan. The index lists them newest first, so a cold
 * cache fills the threads the user is looking at and leaves the rest to the
 * next pass instead of reading a whole history at once.
 */
const REFILLS_PER_PASS = 16;

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined;
}

function add(total: UsageTally, usage: Record<string, unknown>): void {
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : undefined;
  total.inputTokens += number(usage.input);
  total.outputTokens += number(usage.output);
  total.cacheReadTokens += number(usage.cacheRead);
  total.cacheWriteTokens += number(usage.cacheWrite);
  total.totalTokens += number(usage.totalTokens);
  total.costUsd += number(cost?.total);
}

/**
 * What a session's entries were billed for, one tally per provider and model.
 * Mirrors Pi's own `getSessionStats`: assistant and tool-result messages carry
 * usage, and so do the summary entries a compaction leaves behind, which count
 * for the model that ran last. `turns` counts the billed assistant messages.
 */
export function sessionTalliesFromEntries(entries: Iterable<unknown>): UsageTally[] {
  const tallies = new Map<string, UsageTally>();
  let last: { provider?: string; model?: string } = {};
  const tallyFor = (model: { provider?: string; model?: string }): UsageTally => {
    const key = `${model.provider ?? ""}\u0000${model.model ?? ""}`;
    let tally = tallies.get(key);
    if (!tally) tallies.set(key, tally = { ...(model.provider ? { provider: model.provider } : {}), ...(model.model ? { model: model.model } : {}), ...emptyTally() });
    return tally;
  };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as { type?: unknown; message?: unknown };
    if (typed.type === "branch_summary" || typed.type === "compaction") {
      const usage = usageOf(entry);
      if (usage) add(tallyFor(last), usage);
      continue;
    }
    if (typed.type !== "message") continue;
    const message = typed.message;
    if (!message || typeof message !== "object") continue;
    const { role, provider, model } = message as { role?: unknown; provider?: unknown; model?: unknown };
    if (role !== "assistant" && role !== "toolResult") continue;
    if (role === "assistant" && (typeof provider === "string" || typeof model === "string")) {
      last = { ...(typeof provider === "string" && provider ? { provider } : {}), ...(typeof model === "string" && model ? { model } : {}) };
    }
    const usage = usageOf(message);
    if (!usage) continue;
    const tally = tallyFor(last);
    add(tally, usage);
    if (role === "assistant") tally.turns += 1;
  }
  return [...tallies.values()].filter((tally) => tally.turns > 0 || tally.totalTokens > 0 || tally.costUsd > 0);
}

/** A thread nobody has paid for yet shows nothing rather than a zero. */
export function hasThreadUsage(usage: UiThreadUsage | undefined): usage is UiThreadUsage {
  return usage !== undefined && (usage.turns > 0 || usage.totalTokens > 0 || usage.costUsd > 0);
}

/**
 * Streams a session file and sums its usage. Only lines that mention a usage
 * record are parsed; a session's bulk is tool output, and parsing that back
 * costs more than reading the file.
 *
 * Returns `undefined` when the file could not be read (not that the thread is
 * free). When the file is readable but individual lines are corrupt, they are
 * counted in `skipped` so the caller can decide whether to log or surface it.
 */
export async function readSessionUsage(
  path: string,
  options?: { logger?: PersistedJsonLogger },
): Promise<{ tallies: UsageTally[]; skipped: number } | undefined> {
  const entries: unknown[] = [];
  let skipped = 0;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes("\"usage\"")) continue;
      try { entries.push(JSON.parse(line)); } catch { skipped += 1; continue; }
    }
  } catch (error) {
    // A missing file is expected (thread has no recorded usage yet); any other
    // failure means the data may be partial — worth logging so it isn’t silent.
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      options?.logger?.warn("session-usage.read.failed", `${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
  return { tallies: sessionTalliesFromEntries(entries), skipped };
}

export async function readSessionFileStamp(path: string): Promise<SessionFileStamp | undefined> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

interface CacheEntry extends SessionFileStamp {
  path: string;
  tallies: UsageTally[];
}

function decodeEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || typeof candidate.size !== "number" || typeof candidate.mtimeMs !== "number") return undefined;
  if (!Array.isArray(candidate.tallies)) return undefined;
  return {
    path: candidate.path,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    tallies: candidate.tallies.flatMap((item) => readUsageTally(item) ?? []),
  };
}

export interface SessionUsageIndexOptions {
  /** Where the cache is persisted; without one it lives only for this process. */
  path?: string;
  /** A queued read finished. The index scan republishes the thread's shell. */
  onResolved?(sessionPath: string, tallies: readonly UsageTally[]): void;
  /** Session files read at once when the cache misses. */
  concurrency?: number;
  /** Session files read per scan; what does not fit waits for the next one. */
  refillsPerPass?: number;
  logger?: PersistedJsonLogger;
}

/**
 * What each session file cost, keyed by path plus size and mtime. A scan only
 * ever reads this cache; a miss is filled afterwards, off the scan's path, so
 * the index never pays for parsing every session file it lists.
 */
export class SessionUsageIndex {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly queue = new Map<string, SessionFileStamp>();
  private readonly options: SessionUsageIndexOptions;
  private running = 0;
  private dirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private drained = Promise.resolve();
  private disposed = false;

  constructor(options: SessionUsageIndexOptions = {}) {
    this.options = options;
  }

  async load(): Promise<void> {
    if (!this.options.path) return;
    const read = await readPersistedJson<CacheEntry[]>(this.options.path, {
      expectedVersion: CACHE_VERSION,
      decode: (value) => {
        const list = (value as { entries?: unknown })?.entries;
        return Array.isArray(list) ? list.flatMap((item) => decodeEntry(item) ?? []) : undefined;
      },
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
    for (const entry of read?.data ?? []) this.entries.set(entry.path, entry);
  }

  /**
   * Cached usage for a session file. A miss or a stale stamp queues a read; a
   * stale value is still returned, so a growing thread shows its last cost
   * instead of blinking away until the refill lands.
   */
  lookup(sessionPath: string, stamp: SessionFileStamp | undefined): readonly UsageTally[] | undefined {
    const entry = this.entries.get(sessionPath);
    if (!stamp) return entry?.tallies;
    if (entry && entry.size === stamp.size && entry.mtimeMs === stamp.mtimeMs) return entry.tallies;
    this.enqueue(sessionPath, stamp);
    return entry?.tallies;
  }

  /** A live runtime's own count. It supersedes the cache and cancels a queued read. */
  record(sessionPath: string, stamp: SessionFileStamp | undefined, tallies: readonly UsageTally[]): void {
    this.queue.delete(sessionPath);
    if (!stamp) return;
    const entry = this.entries.get(sessionPath);
    if (entry && entry.size === stamp.size && entry.mtimeMs === stamp.mtimeMs && JSON.stringify(entry.tallies) === JSON.stringify(tallies)) return;
    this.entries.set(sessionPath, { path: sessionPath, ...stamp, tallies: tallies.map((tally) => ({ ...tally })) });
    this.markDirty();
  }

  /** Every cached session's tallies, for pricing them again. */
  cached(): ReadonlyMap<string, readonly UsageTally[]> {
    return new Map([...this.entries].map(([path, entry]) => [path, entry.tallies]));
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

  /** Resolves once every queued read has finished. */
  idle(): Promise<void> {
    return this.drained;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.drained.catch(() => undefined);
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

  private enqueue(sessionPath: string, stamp: SessionFileStamp): void {
    if (this.disposed || this.queue.size >= Math.max(1, this.options.refillsPerPass ?? REFILLS_PER_PASS)) return;
    this.queue.set(sessionPath, stamp);
    const concurrency = Math.max(1, this.options.concurrency ?? 2);
    while (this.running < concurrency && this.queue.size > this.running) {
      this.running += 1;
      const worker = this.drain().finally(() => { this.running -= 1; });
      this.drained = Promise.all([this.drained, worker]).then(() => undefined, () => undefined);
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queue.entries().next();
      if (next.done || this.disposed) return;
      const [sessionPath, stamp] = next.value;
      this.queue.delete(sessionPath);
      const result = await readSessionUsage(sessionPath, this.options.logger ? { logger: this.options.logger } : undefined);
      if (this.disposed) return;
      // A file that changed under the read keeps its old stamp out of the cache.
      const current = await readSessionFileStamp(sessionPath);
      if (!result || !current || current.size !== stamp.size || current.mtimeMs !== stamp.mtimeMs) continue;
      if (result.skipped > 0) {
        this.options.logger?.warn("session-usage.skipped-lines", `${sessionPath}: ${result.skipped} unparseable line(s) skipped`);
      }
      this.entries.set(sessionPath, { path: sessionPath, ...stamp, tallies: result.tallies });
      this.markDirty();
      this.options.onResolved?.(sessionPath, result.tallies);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.options.path || this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }
}
