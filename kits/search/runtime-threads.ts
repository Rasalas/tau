import type { ThreadTextCatalogEntry, ThreadTextChunk, ThreadTextsRequest } from "tau/host-extension";
import type { PersistentMessageIndex } from "./persistent-index.js";
import type { ThreadText } from "./threads.js";

/**
 * The text of the threads other runtimes keep, for the palette's content
 * search: a thread of Codex, the Agent SDK runtime, Antigravity or OpenCode
 * has no session file to read, so each of those kits answers `thread-texts`
 * from its own store. The index asks every few seconds at most, and only for
 * what it lacks. The host persists exported text and retains only versions in
 * memory. The optional memory-only mode keeps its original character budget.
 */

export interface RuntimeThread {
  source: string;
  threadId: string;
  updatedAt: number;
  texts: ThreadText[];
}

interface Held extends RuntimeThread {
  chars: number;
  omitted?: boolean;
  version?: string;
  incomplete?: boolean;
}

export interface RuntimeThreadIndexOptions {
  /** The kits that answer `thread-texts`, by extension id. */
  sources: readonly string[];
  /** Disk-backed exports retain every thread without keeping its text in RAM. */
  persistent?: PersistentMessageIndex;
  ask(source: string, input: ThreadTextsRequest & { known: Record<string, number>; limit: number }): Promise<unknown>;
  now?(): number;
  /** A sync within this long of the last one answers from the index as it is. */
  intervalMs?: number;
  /** Threads per answer and answers per source and sync; the rest waits for the next sync. */
  limit?: number;
  rounds?: number;
  /** Characters the index keeps across every thread. */
  budgetChars?: number;
  /** A complete canonical host export or tombstone has replaced this provider's alias. */
  ignore?(threadId: string): boolean;
  ignoreRevision?(): number;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function texts(value: unknown): ThreadText[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const message = record(entry);
    return (message.role === "user" || message.role === "assistant") && typeof message.text === "string" && message.text
      ? [{ role: message.role, text: message.text }]
      : [];
  });
}

export interface RuntimeSearchCoverage {
  source: string;
  state: "complete" | "partial" | "unavailable";
  reason?: "legacy-prefix" | "export-failed" | "catalog-stalled" | "memory-budget";
}

export class RuntimeThreadIndex {
  private readonly threads = new Map<string, Held>();
  private readonly now: () => number;
  private chars = 0;
  private readonly incompleteSources = new Set<string>();
  private syncing: Promise<void> | undefined;
  private syncedAt = Number.NEGATIVE_INFINITY;
  private loaded = false;
  private ignoreRevision?: number;
  private readonly available = new Set<string>();
  private readonly pagedSources = new Set<string>();
  private readonly coverageBySource = new Map<string, RuntimeSearchCoverage>();

  /** Older providers are explicitly partial, even when every prefix was read. */
  coverage(): RuntimeSearchCoverage[] {
    return this.options.sources.map(source => this.coverageBySource.get(source) ?? { source, state: "unavailable" });
  }
  private key(source: string, id: string): string { return JSON.stringify([source, id]); }

  constructor(private readonly options: RuntimeThreadIndexOptions) {
    this.now = options.now ?? Date.now;
  }

  /** How many characters the index holds; the budget caps it. */
  get size(): number {
    return this.chars;
  }

  /** Brings the index up to date unless it was a moment ago; one sync runs at a time. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const revision = this.options.ignoreRevision?.();
    if (revision !== this.ignoreRevision) { this.ignoreRevision = revision; this.syncedAt = Number.NEGATIVE_INFINITY; }
    if (this.now() - this.syncedAt < (this.options.intervalMs ?? 5_000)) return Promise.resolve();
    const run = (async () => {
      if (!this.loaded && this.options.persistent) {
        for (const entry of await this.options.persistent.catalog()) {
          if (!this.options.sources.includes(entry.source)) continue;
          this.threads.set(this.key(entry.source, entry.id), { source: entry.source, threadId: entry.id, updatedAt: entry.updatedAt, texts: [], chars: 0 });
        }
        this.loaded = true;
      }
      // Export answers are bounded, and persisting one source at a time avoids
      // holding answers from every runtime together.
      for (const thread of [...this.threads.values()]) if (this.options.ignore?.(thread.threadId)) await this.drop(thread.source, thread.threadId);
      for (const source of this.options.sources) await this.syncSource(source);
    })().then(() => {
      this.syncedAt = this.now();
      this.trim();
    }).finally(() => { this.syncing = undefined; });
    this.syncing = run;
    return run;
  }

  /** Unread export pages, evicted text, and failed sources make coverage partial. */
  get truncated(): boolean {
    return this.incompleteSources.size > 0 || [...this.threads.values()].some(thread => thread.omitted || thread.incomplete || thread.chars >= 64_000)
      || Boolean(this.options.persistent && this.coverage().some(source => source.state === "partial" || source.reason === "export-failed"));
  }

  /** Every thread whose text is held, newest first. */
  entries(): RuntimeThread[] {
    return [...this.threads.values()].filter((thread) => thread.texts.length > 0).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async syncSource(source: string): Promise<void> {
    if (this.options.persistent) {
      await this.syncPagedSource(source);
      return;
    }
    await this.syncLegacySource(source);
  }

  private async syncPagedSource(source: string): Promise<void> {
    const attempted = new Map<string, string>();
    let failed = false;
    this.available.delete(source);
    for (;;) {
      const known: Record<string, number> = Object.create(null) as Record<string, number>;
      const knownVersions: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const thread of this.threads.values()) if (thread.source === source) {
        known[thread.threadId] = thread.updatedAt;
        if (thread.version) knownVersions[thread.threadId] = thread.version;
      }
      for (const [id, version] of attempted) knownVersions[id] = version;
      let answer: Record<string, unknown>;
      try { answer = record(await this.options.ask(source, { protocol: 2, knownVersions, known, limit: this.options.limit ?? 25 })); }
      catch {
        if (this.pagedSources.has(source)) {
          this.available.delete(source);
          this.coverageBySource.set(source, { source, state: "unavailable", reason: "export-failed" }); return;
        }
        // Strict older providers may reject the opt-in field. Retry their old
        // command shape and advertise prefix-only coverage if that works.
        await this.syncLegacySource(source);
        return;
      }
      if (answer.protocol !== 2) {
        await this.syncLegacySource(source, answer);
        return;
      }
      if (!Array.isArray(answer.catalog) || !Array.isArray(answer.removed)) {
        this.coverageBySource.set(source, { source, state: "unavailable", reason: "export-failed" }); return;
      }
      this.pagedSources.add(source);
      this.available.add(source);
      for (const id of answer.removed) if (typeof id === "string") await this.drop(source, id);
      let progress = false;
      for (const raw of answer.catalog) {
        const entry = record(raw);
        if (typeof entry.threadId !== "string" || typeof entry.version !== "string" || !entry.version
          || typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) { failed = true; continue; }
        if (attempted.has(entry.threadId)) { failed = true; continue; }
        attempted.set(entry.threadId, entry.version);
        if (this.options.ignore?.(entry.threadId)) {
          await this.drop(source, entry.threadId);
          progress = true;
          continue;
        }
        const catalog = entry as unknown as ThreadTextCatalogEntry;
        // A confirmed changed version must not keep serving an old generation
        // while its replacement is incomplete. The file itself stays atomic.
        await this.drop(source, catalog.threadId, false);
        this.threads.set(this.key(source, catalog.threadId), { source, threadId: catalog.threadId,
          updatedAt: catalog.updatedAt, texts: [], chars: 0, incomplete: true });
        try {
          await this.options.persistent!.putRuntimeStream(source, catalog.threadId, catalog.updatedAt, catalog.version,
            () => this.pages(source, catalog));
          this.threads.set(this.key(source, catalog.threadId), { source, threadId: catalog.threadId,
            updatedAt: catalog.updatedAt, version: catalog.version, texts: [], chars: 0 });
        } catch { failed = true; }
        progress = true;
      }
      if (answer.more !== true || !progress) {
        this.coverageBySource.set(source, { source, state: failed || answer.more === true ? "partial" : "complete",
          ...(failed ? { reason: "export-failed" as const } : answer.more === true ? { reason: "catalog-stalled" as const } : {}) });
        return;
      }
    }
  }

  private async *pages(source: string, entry: ThreadTextCatalogEntry): AsyncGenerator<ThreadTextChunk> {
    let cursor: string | undefined;
    for (;;) {
      const answer = record(await this.options.ask(source, { protocol: 2, known: {}, limit: 1, maxChars: 64_000,
        page: { threadId: entry.threadId, version: entry.version, ...(cursor === undefined ? {} : { cursor }) } }));
      const page = record(answer.page);
      if (answer.protocol !== 2 || page.status !== "ok" || page.threadId !== entry.threadId || page.version !== entry.version
        || !Array.isArray(page.chunks) || page.chunks.length > 256
        || page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.length > 4096 || page.nextCursor === cursor || !page.chunks.length)) {
        throw new Error("Runtime export changed or returned an invalid page");
      }
      let chars = 0;
      for (const raw of page.chunks) {
        const chunk = record(raw);
        if (typeof chunk.text !== "string" || (chars += chunk.text.length) > 64_000) throw new Error("Runtime text page exceeds its budget");
        yield chunk as unknown as ThreadTextChunk;
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor as string;
    }
  }

  private async syncLegacySource(source: string, first?: Record<string, unknown>): Promise<void> {
    this.coverageBySource.set(source, { source, state: "partial", reason: "legacy-prefix" });
    for (let round = 0; this.options.persistent || round < (this.options.rounds ?? 4); round += 1) {
      const known: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const thread of this.threads.values()) if (thread.source === source) known[thread.threadId] = thread.incomplete ? -Number.MAX_VALUE : thread.updatedAt;
      let answer: Record<string, unknown>;
      try {
        answer = first ?? record(await this.options.ask(source, { known, limit: this.options.limit ?? 25 }));
        first = undefined;
      } catch {
        // The kit is off, missing or older than this command: its threads are found by title only.
        if ([...this.threads.values()].some(thread => thread.source === source)) this.incompleteSources.add(source);
        this.available.delete(source);
        this.coverageBySource.set(source, { source, state: "unavailable", ...(this.incompleteSources.has(source) ? { reason: "export-failed" as const } : {}) });
        return;
      }
      if (!Array.isArray(answer.threads) || !Array.isArray(answer.removed)) { this.available.delete(source); this.coverageBySource.set(source, { source, state: "unavailable" }); return; }
      this.available.add(source);
      let progress = false;
      for (const id of Array.isArray(answer.removed) ? answer.removed : []) if (typeof id === "string") await this.drop(source, id);
      for (const entry of Array.isArray(answer.threads) ? answer.threads : []) {
        const thread = record(entry);
        if (typeof thread.threadId !== "string" || typeof thread.updatedAt !== "number" || !Number.isFinite(thread.updatedAt)) continue;
        if (this.options.ignore?.(thread.threadId)) { await this.drop(source, thread.threadId); continue; }
        const key = this.key(source, thread.threadId);
        if (this.threads.get(key)?.updatedAt === thread.updatedAt && !this.threads.get(key)?.incomplete) continue;
        progress = true;
        await this.drop(source, thread.threadId, false);
        const held: Held = { source, threadId: thread.threadId, updatedAt: thread.updatedAt, texts: texts(thread.messages), chars: 0 };
        held.chars = held.texts.reduce((sum, text) => sum + text.text.length, 0);
        if (this.options.persistent) {
          await this.options.persistent.putRuntime(source, held.threadId, held.updatedAt, held.texts);
          held.texts = []; held.chars = 0;
        }
        this.threads.set(key, held);
        this.chars += held.chars;
      }
      if (answer.more !== true) { this.incompleteSources.delete(source); return; }
      this.incompleteSources.add(source);
      if (!progress) return;
    }
  }

  private async drop(source: string, threadId: string, removeFile = true): Promise<void> {
    const key = this.key(source, threadId);
    const held = this.threads.get(key);
    if (held) this.chars -= held.chars;
    this.threads.delete(key);
    if (removeFile) await this.options.persistent?.drop({ source, id: threadId, path: "" });
  }

  /** Persisted text is scanned in bounded chunks, including exports beyond the old RAM budget. */
  async *search(tokens: readonly string[], candidates?: ReadonlySet<string>, excluded?: string) {
    for (const thread of this.threads.values()) {
      if (thread.incomplete || thread.threadId === excluded || candidates && !candidates.has(thread.threadId)) continue;
      if (!this.options.persistent || !this.available.has(thread.source)) continue;
      try {
        const found = await this.options.persistent.searchRuntime(thread.source, thread.threadId, tokens);
        if (found) yield { ...found, threadId: thread.threadId };
      } catch {
        // A damaged export must be requested again rather than advertised as
        // known forever. The active transcript remains available to the host.
        await this.drop(thread.source, thread.threadId);
        this.coverageBySource.set(thread.source, { source: thread.source, state: "partial", reason: "export-failed" });
        this.syncedAt = Number.NEGATIVE_INFINITY;
      }
    }
  }

  /** Over budget, the oldest threads give up their text and keep their version. */
  private trim(): void {
    const budget = this.options.budgetChars ?? 4_000_000;
    if (this.chars <= budget) return;
    const oldest = [...this.threads.values()].filter((thread) => thread.chars > 0).sort((left, right) => left.updatedAt - right.updatedAt);
    for (const thread of oldest) {
      if (this.chars <= budget) break;
      this.chars -= thread.chars;
      this.coverageBySource.set(thread.source, { source: thread.source, state: "partial", reason: "memory-budget" });
      thread.chars = 0;
      thread.texts = [];
      thread.omitted = true;
    }
  }
}
