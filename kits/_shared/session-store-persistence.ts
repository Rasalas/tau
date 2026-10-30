import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { readPersistedJson, THREAD_TEXT_CHARS, threadTextsDelta, threadTextPage, threadTextsCatalog, tryProcessLock, writePersistedJson, type PersistedJsonLogger, type StoredThreadText, type ThreadText, type ThreadTextsAnswer, type ThreadTextsRequest } from "tau/host-extension";
import { sessionStoreSqliteWorkerMain, type SqliteChanges, type SqliteDatabaseStats, type SqliteSessionChange, type SqliteStoreRead } from "./session-store-persistence-worker.js";
import type { SessionDatabaseStatus } from "./session-database-protocol.js";
import { sqliteRecoveryMessage } from "./session-database-errors.js";

interface SessionStoreData<T, M> { sessions: T[]; models?: Record<string, M[]> }
interface Changes<T, M> {
  sessions?: Array<{ id: string; record?: T; appendOnly?: boolean }>;
  models?: Array<{ id: string; models: M[] }>;
}
const LAYOUT = "sqlite-sessions";
interface Snapshot { summary?: string; revision: string; messages?: unknown[]; count: number; usage: unknown[]; start: number; next: number }
interface MessagePointer { epoch: string; count: number; parts: number; tailCount: number; tailBytes: number }
const MESSAGE_CHUNK_MAX_COUNT = 64;
const HISTORY_CACHE_ENTRIES = 8;
const HISTORY_CACHE_CHARS = 4_000_000;
const INCREMENTAL = 2;
const LEGACY_FILE = /^(session|models|message)-[a-f0-9]{64}.*\.(json|tmp)$/;

/** Idle maintenance: when it runs, what is worth reclaiming, and how long the pre-SQLite files stay. */
export interface SessionDatabaseMaintenance {
  /** Quiet time after the last store request before maintenance starts. */
  idleMs: number;
  /** Least time between two scheduled passes. */
  minIntervalMs: number;
  minBytes: number;
  /** Free share of the file. */
  minRatio: number;
  /** Bytes returned per worker round, so a pending write can interrupt. */
  stepBytes: number;
  /** Wait after the migration before its source files go. */
  legacyGraceMs: number;
}
export const SESSION_DATABASE_MAINTENANCE: SessionDatabaseMaintenance = {
  idleMs: 60_000, minIntervalMs: 30 * 60_000, minBytes: 8 * 1024 * 1024, minRatio: 0.25, stepBytes: 4 * 1024 * 1024, legacyGraceMs: 7 * 86_400_000,
};

/** Enough of the file is free to be worth a pass. */
export function reclaimDue(stats: Pick<SqliteDatabaseStats, "pageSize" | "pageCount" | "freePages">, rules: Pick<SessionDatabaseMaintenance, "minBytes" | "minRatio">): boolean {
  return stats.freePages * stats.pageSize >= rules.minBytes && stats.freePages >= stats.pageCount * rules.minRatio;
}

/** Durable changed-row transactions; synchronous SQLite work stays off the host loop. */
export class SessionStorePersistence<T extends { tauThreadId: string }, M = never> {
  readonly databasePath: string;
  private readOnlyData = false;
  private databaseIdentity?: { dev: number; ino: number };
  private loading?: Promise<SessionStoreData<T, M> | undefined>;
  private readonly histories = new Map<string, T>();
  private readonly historyWeights = new Map<string, { messages: number; usage: number }>();
  private readonly pendingWrites = new Map<string, number>();
  private readonly bulkReaders = new Map<string, number>();
  private readonly failedHistories = new Set<string>();
  private cacheTimer?: ReturnType<typeof setImmediate>;
  private readonly hydrating = new Map<string, Promise<T | undefined>>();
  private readonly unloaded = new Set<string>();
  /** The revision of each thread this host last read or wrote. */
  private readonly committed = new Map<string, string>();
  /** Threads whose snapshot a failed write left unknown, with the revision to rewrite them over. */
  private readonly invalid = new Map<string, string | undefined>();
  /** Threads another writer changed under a failed write; their next read starts from the database. */
  private readonly stale = new Set<string>();
  private readonly summaries = new Map<string, { firstUser?: unknown; tallies?: unknown[] }>();
  private writing: Promise<void> = Promise.resolve();
  private readonly snapshots = new Map<string, Snapshot>();
  private generation = 0;
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private disposed = false;
  private closing?: Promise<void>;
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private maintaining = false;
  private lastMaintenanceAt = 0;
  private readonly rules: SessionDatabaseMaintenance;
  private readonly requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly directory: string;

  constructor(private readonly options: {
    filePath: string; version: number;
    decode(value: unknown): SessionStoreData<T, M> | undefined;
    encode?(data: SessionStoreData<T, M>): Record<string, unknown>;
    encodeMessage?(message: unknown): unknown;
    /** Synchronously install/remove the adapter record before loaded state is visible.
     * Must not throw, await, or initiate store operations. Reader promises are completion
     * signals only; their returned records must never be installed by a later continuation.
     */
    publishHydrated?(id: string, record: T | undefined): void;
    /** Enables bounded caching. Adapter operations must consume or freeze a hydrated
     * record in their promise continuation, without retaining it across further I/O.
     * Eviction runs on a later event-loop turn and installs metadata atomically.
     */
    publishEvicted?(id: string, metadata: T): void;
    immutableUsageTurns?: boolean;
    summarizeUsage?(record: T): unknown[] | undefined;
    /** Invalidate summaries when a runtime changes how persisted usage is decoded. */
    summaryVersion?: number;
    logger?: PersistedJsonLogger;
    maintenance?: Partial<SessionDatabaseMaintenance>;
  }) {
    this.databasePath = `${options.filePath}.sqlite`; this.directory = `${options.filePath}.records`;
    this.rules = { ...SESSION_DATABASE_MAINTENANCE, ...options.maintenance };
  }

  private request(operation: string, values: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Session store is disposed"));
    clearTimeout(this.timer);
    if (!this.worker) {
      const worker = new Worker(`import("node:module").then(({ createRequire }) => (${sessionStoreSqliteWorkerMain.toString()})(createRequire(process.execPath), { page: ${threadTextPage.toString()}, catalog: ${threadTextsCatalog.toString()} }))`, { eval: true, workerData: { path: this.databasePath, summaryVersion: this.options.summaryVersion } });
      this.worker = worker;
      worker.on("message", (reply: { id: number; value?: unknown; error?: string; errcode?: unknown }) => {
        const pending = this.requests.get(reply.id);
        this.requests.delete(reply.id);
        if (reply.error) pending?.reject(this.failure(reply.error, reply.errcode)); else pending?.resolve(reply.value);
        if (!this.requests.size && this.worker === worker) {
          worker.unref();
          this.timer = setTimeout(() => { if (this.worker === worker && !this.requests.size) { this.worker = undefined; void worker.terminate(); } }, 30_000);
          this.timer.unref();
          this.scheduleMaintenance();
        }
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const pending of this.requests.values()) pending.reject(error);
        this.requests.clear();
      };
      worker.on("error", failed);
      worker.on("exit", (code) => failed(new Error(`Session SQLite worker exited (${code})`)));
    }
    this.worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.requests.set(id, { resolve, reject }); this.worker!.postMessage({ id, operation, ...values }); });
  }

  /** Known SQLite failures read as a sentence plus a next step; the driver text stays in `cause` and the log. */
  private failure(message: string, errcode: unknown): Error {
    const sentence = sqliteRecoveryMessage(errcode);
    if (!sentence) return new Error(message);
    this.options.logger?.warn(`Session database failed: ${message}`);
    return new Error(sentence, { cause: new Error(message) });
  }

  private async closeWorker(): Promise<void> {
    try { if (this.worker) await this.request("close"); }
    finally {
      clearTimeout(this.timer);
      const worker = this.worker; this.worker = undefined;
      await worker?.terminate();
    }
  }

  /** Release the worker after accepted writes. Retained runtimes may write again after kit reload. */
  flushAndRelease(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const release = this.writing.catch(() => undefined).then(async () => {
      if (this.loading) await this.loading.catch(() => undefined);
      await this.locked(async () => {
        await this.closeWorker();
        this.evictHistories(true);
      });
    });
    this.writing = release;
    return release;
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.flushAndRelease().finally(() => { this.disposed = true; clearTimeout(this.maintenanceTimer); });
    return this.closing;
  }

  /** After a quiet spell, never during startup: the timer only arms once the store has been used. */
  private scheduleMaintenance(): void {
    if (this.disposed || this.closing || this.maintaining || this.readOnlyData) return;
    clearTimeout(this.maintenanceTimer);
    const wait = Math.max(this.rules.idleMs, this.lastMaintenanceAt + this.rules.minIntervalMs - Date.now());
    this.maintenanceTimer = setTimeout(() => {
      if (this.requests.size || this.pendingWrites.size) { this.scheduleMaintenance(); return; }
      this.reclaim(false).catch((error) => this.options.logger?.warn("Session database maintenance failed", error));
    }, wait);
    this.maintenanceTimer.unref();
  }

  private async measure(): Promise<number> {
    let size = 0;
    for (const path of [this.databasePath, `${this.databasePath}-wal`]) size += await stat(path).then((info) => info.size, () => 0);
    return size;
  }

  private status(stats: SqliteDatabaseStats | undefined, sizeBytes: number): SessionDatabaseStatus {
    return { sizeBytes, reclaimableBytes: stats ? stats.freePages * stats.pageSize : 0, ...(stats?.lastReclaim ? { lastReclaim: stats.lastReclaim } : {}) };
  }

  /** File size and free space, read without migrating anything; a store with no database reports zero. */
  async databaseStatus(): Promise<SessionDatabaseStatus> {
    if (this.disposed || this.closing || !existsSync(this.databasePath)) return this.status(undefined, 0);
    return this.locked(async () => {
      try {
        await this.checkMarker();
        return this.status(await this.request("database-status") as SqliteDatabaseStats, await this.measure());
      } catch { return this.status(undefined, await this.measure()); }
      finally { await this.closeWorker(); }
    });
  }

  /**
   * Gives deleted rows' space back: converts the file to incremental vacuum
   * once, returns free pages in steps that stop for any queued write, folds
   * the log back, and drops the pre-SQLite files after a recorded migration.
   * `force` ignores the size thresholds (the "Reclaim now" button).
   */
  reclaim(force = true): Promise<SessionDatabaseStatus> {
    if (this.disposed || this.closing) return Promise.reject(new Error("Session store is disposed"));
    const run = this.writing.catch(() => undefined).then(async () => {
      if (!existsSync(this.databasePath)) return this.status(undefined, 0);
      await this.loadData();
      if (this.readOnlyData) return this.status(undefined, await this.measure());
      return this.locked(() => this.reclaimLocked(force));
    });
    this.writing = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reclaimLocked(force: boolean): Promise<SessionDatabaseStatus> {
    await this.checkMarker();
    this.maintaining = true;
    try {
      let stats = await this.request("database-status") as SqliteDatabaseStats;
      const pagesBefore = stats.pageCount;
      let deferred = this.pendingWrites.size > 0;
      // The one full VACUUM holds the store lock, so a file converts only when there is space to give back.
      if (!deferred && stats.autoVacuum !== INCREMENTAL && (force ? stats.freePages > 0 : reclaimDue(stats, this.rules))) {
        stats = await this.request("convert-incremental") as SqliteDatabaseStats;
      }
      if (!deferred && (force ? stats.freePages > 0 : reclaimDue(stats, this.rules))) {
        const pages = Math.max(1, Math.floor(this.rules.stepBytes / stats.pageSize));
        while (stats.freePages > 0) {
          if (this.pendingWrites.size) { deferred = true; break; }
          stats = await this.request("reclaim-step", { pages }) as SqliteDatabaseStats;
        }
      }
      let reclaimedBytes = 0;
      if (!this.pendingWrites.size) {
        reclaimedBytes = Math.max(0, pagesBefore - stats.pageCount) * stats.pageSize;
        stats = await this.request("reclaim-finish", { at: Date.now(), bytes: reclaimedBytes }) as SqliteDatabaseStats;
        if (stats.migrated) await this.removeLegacy();
      } else deferred = true;
      await this.closeWorker();
      return { ...this.status(stats, await this.measure()), reclaimedBytes, ...(deferred ? { deferred } : {}) };
    } finally {
      this.lastMaintenanceAt = Date.now();
      await this.closeWorker().catch(() => undefined);
      this.maintaining = false;
    }
  }

  /** Only once the database holds the recorded import, and only after a grace period for a rollback by hand. */
  private async removeLegacy(): Promise<void> {
    const backup = `${this.options.filePath}.pre-sqlite`;
    const born = await stat(backup).then((info) => info.mtimeMs, () => stat(this.directory).then((info) => info.mtimeMs, () => undefined));
    if (born === undefined || Date.now() - born < this.rules.legacyGraceMs) return;
    try {
      for (const name of await readdir(this.directory).catch(() => [])) if (LEGACY_FILE.test(name)) await rm(join(this.directory, name), { force: true });
      await rmdir(this.directory).catch(() => undefined);
      await rm(backup, { force: true });
    } catch (error) { this.options.logger?.warn("Pre-SQLite session files were not removed", error); }
  }

  /** Compatibility full-record read. Store recovery uses loadMetadata instead. */
  async load(): Promise<SessionStoreData<T, M> | undefined> {
    const data = await this.loadMetadata();
    if (!data || this.readOnlyData) return data;
    const records = await this.loadSessions(data.sessions.map(record => record.tauThreadId));
    return { sessions: records.filter((record): record is T => record !== undefined), models: data.models };
  }

  /** Explicit full listings hydrate their requested IDs in one bounded worker. */
  async loadSessions(ids: string[]): Promise<Array<T | undefined>> {
    for (const id of ids) this.bulkReaders.set(id, (this.bulkReaders.get(id) ?? 0) + 1);
    try {
      await this.loadMetadata();
      await Promise.all(ids.map(id => this.hydrating.get(id)));
      return await this.locked(async () => {
        const missing = ids.filter(id => this.unloaded.has(id));
        if (missing.length) {
          await this.checkMarker();
          let records: Array<readonly [SqliteStoreRead["sessions"][number], T]>;
          try {
            const loaded = await this.request("histories", { threadIds: missing }) as SqliteStoreRead;
            records = loaded.sessions.map(row => [row, this.decodeRow(row)] as const);
          } finally { await this.closeWorker(); }
          const found = new Set(records.map(([row]) => row.id));
          for (const [row, record] of records) this.publishHydrated(row.id, row, record);
          for (const id of missing) {
            if (!found.has(id)) this.publishHydrated(id);
          }
        }
        return ids.map(id => this.histories.get(id));
      });
    } finally {
      for (const id of ids) {
        const count = this.bulkReaders.get(id)! - 1;
        if (count) this.bulkReaders.set(id, count); else this.bulkReaders.delete(id);
      }
      this.scheduleEviction();
    }
  }

  loadMetadata(): Promise<SessionStoreData<T, M> | undefined> {
    if (this.closing || this.disposed) return Promise.reject(new Error("Session store is disposed"));
    return this.loadData();
  }

  /** Usage reports require dated turns across threads, but no transcripts. */
  async loadUsage(): Promise<T[]> {
    await this.loadMetadata();
    return this.locked(async () => {
      await this.checkMarker();
      try {
        const loaded = await this.request("usage") as SqliteStoreRead;
        return loaded.sessions.map(row => this.decodeRow(row));
      } finally { await this.closeWorker(); }
    });
  }

  /** Legacy prefixes or versioned full exports; payloads stay in the text worker. */
  async threadTexts(records: Iterable<StoredThreadText>, input: unknown): Promise<ThreadTextsAnswer> {
    const catalog = Array.from(records);
    if (this.readOnlyData) return threadTextsDelta(catalog, input);
    const fields = input && typeof input === "object" ? input as ThreadTextsRequest : {};
    if (fields.protocol === 2) {
      await this.writing;
      return this.locked(async () => {
        await this.checkMarker();
        try { return await this.request("text-page", { input: fields, version: this.options.version }) as ThreadTextsAnswer; }
        finally { await this.closeWorker(); }
      });
    }
    const answer = threadTextsDelta(catalog.map(record => ({ tauThreadId: record.tauThreadId, updatedAt: record.updatedAt, messages: [] })), input);
    if (!answer.threads.length) return answer;
    await this.writing;
    return this.locked(async () => {
      await this.checkMarker();
      try {
        const threads = await this.request("texts", { threadIds: answer.threads.map(thread => thread.threadId),
          textChars: THREAD_TEXT_CHARS, version: this.options.version }) as ThreadText[];
        return { ...answer, threads };
      } finally { await this.closeWorker(); }
    });
  }

  messageCount(id: string): number | undefined { return this.snapshots.get(id)?.count; }
  isUnloaded(id: string): boolean { return this.unloaded.has(id); }
  touch(id: string): void {
    const record = this.histories.get(id);
    if (record) { this.histories.delete(id); this.histories.set(id, record); }
  }
  usageTallies(id: string): unknown[] | undefined { return this.summaries.get(id)?.tallies?.map(tally => ({ ...tally as object })); }

  /** One read transaction returns current metadata and exactly this history. */
  loadSession(id: string): Promise<T | undefined> {
    if (this.closing || this.disposed) return Promise.reject(new Error("Session store is disposed"));
    let pending = this.hydrating.get(id);
    if (!pending) {
      pending = this.readSession(id).finally(() => this.hydrating.delete(id));
      this.hydrating.set(id, pending);
    }
    return pending;
  }

  private forgetAbsent(id: string): void {
    this.unloaded.delete(id);
    this.snapshots.delete(id);
    this.histories.delete(id);
    this.historyWeights.delete(id);
    this.failedHistories.delete(id);
    this.summaries.delete(id);
    this.committed.delete(id);
    this.invalid.delete(id);
    this.stale.delete(id);
  }

  private async readSession(id: string): Promise<T | undefined> {
    await this.loadData();
    if (!this.unloaded.has(id)) {
      this.touch(id);
      return this.histories.get(id);
    }
    return this.locked(async () => {
      // Bulk hydration may have finished while this reader waited for the lock.
      // Reuse its live record and any revision already frozen by a queued write.
      if (!this.unloaded.has(id)) return this.histories.get(id);
      await this.checkMarker();
      let row: SqliteStoreRead["sessions"][number] | undefined;
      let record: T | undefined;
      try {
        const loaded = await this.request("history", { threadId: id }) as SqliteStoreRead;
        row = loaded.sessions[0];
        if (row) record = this.decodeRow(row);
      } finally {
        // Do not retain a reader heap, especially after opening a long thread.
        await this.closeWorker();
      }
      this.publishHydrated(id, row, record);
      return record;
    });
  }

  /** One synchronous ownership transition, after all fallible reader work succeeds. */
  private publishHydrated(id: string, row?: SqliteStoreRead["sessions"][number], record?: T): void {
    if (row && record) {
      this.remember(row, record);
      this.histories.set(id, record);
      const history = record as T & { messages?: unknown[]; usageTurns?: unknown[] };
      this.historyWeights.set(id, { messages: this.payloadWeight(history.messages), usage: this.payloadWeight(history.usageTurns) });
      this.options.publishHydrated?.(id, record);
      this.unloaded.delete(id);
      this.invalid.delete(id); this.stale.delete(id);
      this.scheduleEviction();
    } else {
      this.options.publishHydrated?.(id, undefined);
      this.forgetAbsent(id);
    }
  }

  private payloadWeight(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (!value || typeof value !== "object") return 0;
    return Object.values(value).reduce<number>((size, item) => size + this.payloadWeight(item), 128);
  }

  private scheduleEviction(): void {
    if ((!this.options.publishEvicted && !this.stale.size) || this.cacheTimer) return;
    // Await continuations may still be mutating the live adapter record. Only a
    // later event-loop turn may replace it; frozen writes remain pinned below.
    this.cacheTimer = setImmediate(() => { this.cacheTimer = undefined; this.evictHistories(); });
    this.cacheTimer.unref();
  }

  private evictHistories(all = false): void {
    for (const id of this.stale) {
      if (this.pendingWrites.has(id) || this.bulkReaders.has(id) || this.hydrating.has(id)) continue;
      // Unloaded with no snapshot: the next read takes the other writer's record.
      const record = this.histories.get(id);
      if (record) this.unload(id, record); else this.unloaded.add(id);
      this.snapshots.delete(id); this.committed.delete(id); this.stale.delete(id); this.failedHistories.delete(id);
    }
    if (!this.options.publishEvicted) return;
    let weight = [...this.historyWeights.values()].reduce((total, item) => total + item.messages + item.usage, 0);
    for (const [id, record] of this.histories) {
      if (!all && this.histories.size <= HISTORY_CACHE_ENTRIES && weight <= HISTORY_CACHE_CHARS) break;
      if (this.pendingWrites.has(id) || this.bulkReaders.has(id) || this.hydrating.has(id) || this.invalid.has(id) || this.failedHistories.has(id)) continue;
      const size = this.historyWeights.get(id);
      weight -= (size?.messages ?? 0) + (size?.usage ?? 0);
      this.unload(id, record);
    }
  }

  private unload(id: string, record: T): void {
    const history = record as T & { messages?: Array<{ role?: string }>; usageTurns?: unknown[] };
    const { messages, usageTurns: _usageTurns, ...metadata } = history;
    const firstUser = messages?.find(message => message.role === "user");
    const catalog = { ...metadata, ...(messages ? { messages: firstUser ? [firstUser] : [] } : {}) } as T;
    this.options.publishEvicted?.(id, catalog);
    this.unloaded.add(id);
    this.histories.delete(id);
    const snapshot = this.snapshots.get(id);
    if (snapshot) { snapshot.messages = undefined; snapshot.usage = []; }
    this.historyWeights.delete(id);
  }

  private decodeRow(row: SqliteStoreRead["sessions"][number]): T {
    if (row.version > this.options.version) throw new Error(`Unsupported SQLite session record version: ${row.version}`);
    const data = this.options.decode(row.raw);
    if (!data || data.sessions.length !== 1 || data.sessions[0]!.tauThreadId !== row.id) throw new Error(`Invalid SQLite session: ${row.id}`);
    const record = data.sessions[0]! as T & { messages?: unknown[]; usageTurns?: unknown[] };
    // Runtime decoders must not silently drop a corrupt requested payload.
    const raw = (row.raw as { sessions: Array<{ messages?: unknown[]; usageTurns?: unknown[] }> }).sessions[0]!;
    if ((row.hydrated && raw.messages && record.messages?.length !== raw.messages.length)
      || (row.usageHydrated && raw.usageTurns && record.usageTurns?.length !== raw.usageTurns.length)) throw new Error(`Invalid SQLite history: ${row.id}`);
    return record;
  }

  private summary(record: T): { version?: number; firstUser?: unknown; tallies?: unknown[] } {
    const history = record as T & { messages?: Array<{ role?: string }> };
    const firstUser = history.messages && sessionMessageIndex(history.messages as Array<{ role: string }>).firstUser;
    return { ...(this.options.summaryVersion !== undefined ? { version: this.options.summaryVersion } : {}), ...(firstUser ? { firstUser: this.options.encodeMessage?.(firstUser) ?? firstUser } : {}),
      tallies: this.options.summarizeUsage?.(record) };
  }

  private remember(row: SqliteStoreRead["sessions"][number], record: T): void {
    const history = record as T & { messages?: unknown[]; usageTurns?: unknown[] };
    const storedUsage = (row.raw as { sessions: Array<{ usageTurns?: unknown[] }> }).sessions[0]?.usageTurns ?? [];
    // Decoders may normalize cumulative counters into deltas. Reuse decoded
    // identities only for unchanged persisted rows; otherwise the next CAS
    // write must replace the raw rows before publishing the migration marker.
    const usage = isDeepStrictEqual(storedUsage, history.usageTurns ?? []) ? history.usageTurns ?? [] : storedUsage;
    this.snapshots.set(row.id, { revision: row.revision, messages: row.hydrated ? history.messages : undefined,
      summary: row.summary ? JSON.stringify(row.summary) : undefined, count: row.messageCount, usage: row.hydrated ? usage.slice() : [], start: row.usageStart, next: row.usageNext });
    this.summaries.set(row.id, row.summary ?? this.summary(record));
    this.committed.set(row.id, row.revision);
  }

  private loadData(): Promise<SessionStoreData<T, M> | undefined> {
    this.loading ??= this.locked(async () => {
      try {
        const marker = await this.marker();
        if (marker && marker.data.layout !== LAYOUT && marker.data.layout !== "thread-records" && marker.data.layout !== "thread-records-messages"
          && (marker.data.version ?? 0) > this.options.version) {
          this.readOnlyData = true;
          return (await readPersistedJson(this.options.filePath, { expectedVersion: this.options.version,
            decode: this.options.decode, logger: this.options.logger }))?.data;
        }
        await this.initialize();
        this.databaseIdentity = await stat(this.databasePath);
        let loaded = await this.request("metadata") as SqliteStoreRead;
        // Databases published by the previous version need one transactional
        // summary backfill. Later metadata reads never select payload rows.
        const missing = loaded.sessions.filter(row => row.summary === undefined);
        if (missing.length) {
          await this.request("summaries", { summaries: missing.map(row => ({ id: row.id, revision: row.revision,
            payload: JSON.stringify(this.summary(this.decodeRow(row))) })) });
          loaded = await this.request("metadata") as SqliteStoreRead;
        }
        const sessions: T[] = [], models: Record<string, M[]> = {};
        for (const row of loaded.sessions) {
          const record = this.decodeRow(row);
          sessions.push(record);
          // Pending frozen writes have already established their next revision.
          if (!this.snapshots.has(row.id)) { this.remember(row, record); this.unloaded.add(row.id); }
        }
        for (const row of loaded.models) {
          const entries = this.options.decode(row.raw)?.models?.[row.id];
          if (!entries) throw new Error(`Invalid SQLite model catalog: ${row.id}`);
          models[row.id] = entries;
        }
        return { sessions, models };
      } finally {
        // Close under the same load lock, before resolving the catalog.
        await this.closeWorker();
      }
    }).catch((error) => { this.loading = undefined; throw error; });
    return this.loading;
  }

  private encode(data: SessionStoreData<T, M>): string { return JSON.stringify(this.options.encode?.(data) ?? data); }
  private freeze(id: string, record: T | undefined, appendOnly = false, version = this.options.version): SqliteSessionChange {
    if (record && this.unloaded.has(id)) throw new Error(`Session '${id}' history is not loaded; read it before writing`);
    // After a failed write the whole record is written again, over the revision last known on disk.
    const recovering = appendOnly && this.invalid.has(id);
    const base = this.invalid.get(id);
    if (recovering) this.invalid.delete(id);
    const prior = appendOnly && !recovering ? this.snapshots.get(id) : undefined;
    const history = record as (T & { messages?: unknown[]; usageTurns?: unknown[] }) | undefined;
    const messages = history?.messages;
    const reuse = !!prior && prior.messages === messages && prior.count <= (messages?.length ?? 0);
    const usage = history?.usageTurns ?? [];
    let usageStart = 0, usageNext = usage.length, usageReplace = true, usageRows: Array<{ ordinal: number; payload: string }> = [];
    if (prior && this.options.immutableUsageTurns) {
      // appendUsageTurn may fold the oldest pair; the unchanged suffix keeps its ordinal.
      let oldOffset = usage.length && prior.usage.length ? prior.usage.indexOf(usage[0]) : 0;
      let newOffset = 0;
      if (oldOffset < 0 && usage.length > 1) { oldOffset = prior.usage.indexOf(usage[1]); newOffset = 1; }
      if (oldOffset >= 0 && prior.usage.slice(oldOffset).every((turn, i) => usage[newOffset + i] === turn)) {
        const common = prior.usage.length - oldOffset;
        usageStart = prior.start + oldOffset - newOffset;
        usageNext = usageStart + usage.length;
        usageReplace = false;
        usageRows = usage.flatMap((turn, index) => index >= newOffset && index < newOffset + common ? [] : [{ ordinal: usageStart + index, payload: JSON.stringify(turn) }]);
      }
    }
    if (usageReplace) usageRows = usage.map((turn, ordinal) => ({ ordinal, payload: JSON.stringify(turn) }));
    const revision = randomUUID();
    const unchangedUsage = prior && prior.usage.length === usage.length && prior.usage.every((turn, index) => turn === usage[index]);
    const priorSummary = this.summaries.get(id);
    const sameFirstUser = reuse && (priorSummary?.firstUser !== undefined
      || !(messages ?? []).slice(prior!.count).some(message => (message as { role?: string })?.role === "user"));
    const summary = record ? sameFirstUser && unchangedUsage && prior?.summary !== undefined ? prior.summary
      : JSON.stringify(sameFirstUser ? { ...priorSummary, tallies: this.options.summarizeUsage?.(record) } : this.summary(record)) : undefined;
    const result: SqliteSessionChange = { id, version, revision, expectedRevision: recovering ? base : prior?.revision,
      expectedAbsent: appendOnly && record !== undefined && (recovering ? base === undefined : prior === undefined),
      summary: summary !== prior?.summary ? summary : undefined,
      metadata: record ? this.encode({ sessions: [{ ...record, ...(messages ? { messages: [] } : {}), ...(history?.usageTurns ? { usageTurns: [] } : {}) }] }) : undefined,
      hasMessages: Array.isArray(messages), messageCount: messages?.length ?? 0,
      messages: { replace: !reuse, start: 0, next: messages?.length ?? 0, rows: (messages ?? []).slice(reuse ? prior!.count : 0).map((message, index) => ({ ordinal: (reuse ? prior!.count : 0) + index, payload: JSON.stringify(this.options.encodeMessage?.(message) ?? message) })) },
      hasUsage: Array.isArray(history?.usageTurns), usage: { replace: usageReplace, start: usageStart, next: usageNext, rows: usageRows } };
    if (record) {
      this.histories.delete(id); this.histories.set(id, record);
      this.historyWeights.set(id, { messages: (reuse ? this.historyWeights.get(id)?.messages ?? 0 : 0) + result.messages.rows.reduce((size, row) => size + row.payload.length, 0), usage: this.payloadWeight(usage) });
      this.summaries.set(id, JSON.parse(summary!)); this.snapshots.set(id, { revision, summary, messages, count: messages?.length ?? 0, usage: usage.slice(), start: usageStart, next: usageNext });
    }
    else { this.histories.delete(id); this.forgetAbsent(id); this.summaries.delete(id); }
    return result;
  }

  write(changes: Changes<T, M>): Promise<void> {
    if (this.disposed || this.closing) return Promise.reject(new Error("Session store is disposed"));
    const generation = this.generation;
    let frozen: SqliteChanges;
    try { frozen = { sessions: (changes.sessions ?? []).map(({ id, record, appendOnly }) => this.freeze(id, record, appendOnly)),
      models: (changes.models ?? []).map(({ id, models }) => ({ id, version: this.options.version, payload: this.encode({ sessions: [], models: { [id]: models } }) })) }; }
    catch (error) { return Promise.reject(error); }
    for (const change of frozen.sessions) this.pendingWrites.set(change.id, (this.pendingWrites.get(change.id) ?? 0) + 1);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (generation !== this.generation) throw new Error("Earlier session write failed; retry the update");
      await this.loadData();
      await this.locked(async () => { await this.checkMarker(); await this.request("write", { changes: frozen }); });
      for (const change of frozen.sessions) { if (change.metadata) this.committed.set(change.id, change.revision); else this.committed.delete(change.id); this.failedHistories.delete(change.id); }
    }).catch((error) => {
      if (generation === this.generation) {
        // Only the threads with a write in flight hold a snapshot the database does not have.
        // Another writer's change is read back; otherwise the next write replaces the record.
        this.generation++;
        const conflict = /another writer/u.test(error instanceof Error ? error.message : "");
        for (const id of this.pendingWrites.keys()) {
          this.snapshots.delete(id);
          if (conflict && frozen.sessions.some(change => change.id === id)) { this.stale.add(id); this.invalid.delete(id); }
          else this.invalid.set(id, this.committed.get(id));
        }
      }
      for (const change of frozen.sessions) this.failedHistories.add(change.id);
      throw error;
    }).finally(() => {
      for (const change of frozen.sessions) {
        const count = this.pendingWrites.get(change.id)! - 1;
        if (count) this.pendingWrites.set(change.id, count); else this.pendingWrites.delete(change.id);
      }
      this.scheduleEviction();
    });
    return this.writing;
  }

  private async locked<R>(action: () => Promise<R>): Promise<R> {
    const deadline = Date.now() + 10_000;
    let lock;
    while (!(lock = await tryProcessLock(`${this.options.filePath}.lock`, { pid: process.pid, startedAt: new Date().toISOString() }))) {
      if (Date.now() >= deadline) throw new Error(`Session store is busy: ${this.options.filePath}`);
      await delay(25);
    }
    try { return await action(); } finally { lock.release(); }
  }
  private marker() { return readPersistedJson(this.options.filePath, { expectedVersion: this.options.version + 3,
    decode: (value) => value as { layout?: string; version?: number }, logger: this.options.logger }); }
  private async checkMarker(): Promise<void> {
    const marker = await this.marker();
    if (marker?.readOnly || marker?.data.layout !== LAYOUT || marker.data.version !== this.options.version + 3) throw new Error(`Unsupported session store layout: ${this.options.filePath}`);
    const current = await stat(this.databasePath);
    if (this.databaseIdentity && (current.dev !== this.databaseIdentity.dev || current.ino !== this.databaseIdentity.ino)) throw new Error("SQLite session database was replaced; reload the store");
    if (!current.isFile()) throw new Error(`SQLite session database is unavailable: ${this.databasePath}`);
  }
  private async initialize(): Promise<void> {
    const marker = await this.marker();
    if (marker?.data.layout === LAYOUT) { await this.checkMarker(); return; }
    const layout = marker?.data.layout;
    const expected = layout === "thread-records" ? this.options.version + 1 : layout === "thread-records-messages" ? this.options.version + 2 : this.options.version;
    if (marker && (marker.readOnly || (marker.data.version ?? 0) > expected)) throw new Error(`Unsupported session store version: ${this.options.filePath}`);
    const changes: SqliteChanges = { sessions: [], models: [] };
    const digest = createHash("sha256");
    const add = (data: SessionStoreData<T, M>, version: number) => {
      for (const record of data.sessions) {
        const pending = this.snapshots.get(record.tauThreadId);
        const pendingHistory = this.histories.get(record.tauThreadId);
        const pendingWeight = this.historyWeights.get(record.tauThreadId);
        const pendingSummary = this.summaries.get(record.tauThreadId);
        changes.sessions.push(this.freeze(record.tauThreadId, record, false, version));
        if (pending) {
          this.snapshots.set(record.tauThreadId, pending);
          if (pendingHistory) this.histories.set(record.tauThreadId, pendingHistory);
          if (pendingWeight) this.historyWeights.set(record.tauThreadId, pendingWeight);
          if (pendingSummary) this.summaries.set(record.tauThreadId, pendingSummary);
        } else { this.snapshots.delete(record.tauThreadId); this.histories.delete(record.tauThreadId); this.historyWeights.delete(record.tauThreadId); }
      }
      for (const [id, models] of Object.entries(data.models ?? {})) changes.models.push({ id, version, payload: this.encode({ sessions: [], models: { [id]: models } }) });
    };
    if (layout === "thread-records" || layout === "thread-records-messages") {
      for (const name of (await readdir(this.directory)).sort()) {
        if (!/^(session|models)-[a-f0-9]{64}\.json$/.test(name)) continue;
        const raw = await this.readRawRecord(join(this.directory, name));
        if (!raw) throw new Error(`Unreadable legacy session record: ${name}`);
        if (typeof raw.version === "number" && raw.version > this.options.version) throw new Error(`Unsupported legacy session record version: ${raw.version}`);
        digest.update(name).update(JSON.stringify(raw));
        const data = await this.readRecord(join(this.directory, name));
        if (!data) throw new Error(`Invalid legacy session record: ${name}`);
        digest.update(this.encode(data));
        if (name.startsWith("session-") && data.sessions.some((record) => name !== `session-${createHash("sha256").update(record.tauThreadId).digest("hex")}.json`)) throw new Error(`Session record does not match its storage key: ${name}`);
        add(data, typeof raw.version === "number" ? raw.version : this.options.version);
      }
    } else {
      const legacy = await readPersistedJson(this.options.filePath, { expectedVersion: this.options.version, decode: this.options.decode, logger: this.options.logger });
      if (marker && !legacy) throw new Error(`Unrecognized session store: ${this.options.filePath}`);
      if (legacy) { digest.update(this.encode(legacy.data)); add(legacy.data, this.options.version); }
    }
    await this.request("initialize", { changes, digest: digest.digest("hex") });
    if (marker) {
      const backup = `${this.options.filePath}.pre-sqlite`;
      await copyFile(this.options.filePath, backup, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await chmod(backup, 0o600);
    }
    await writePersistedJson(this.options.filePath, this.options.version + 3, { layout: LAYOUT }, { logger: this.options.logger });
  }
  private messagePath(id: string, epoch: string, index: number): string {
    return join(this.directory, `message-${createHash("sha256").update(id).digest("hex")}-${epoch}-${index}.json`);
  }

  private async readRawRecord(path: string): Promise<(Record<string, unknown> & { messagePointer?: MessagePointer }) | undefined> {
    return (await readPersistedJson(path, { expectedVersion: this.options.version,
      decode: (value) => value as Record<string, unknown> & { messagePointer?: MessagePointer }, logger: this.options.logger }))?.data;
  }

  private async readRecord(path: string): Promise<SessionStoreData<T, M> | undefined> {
    const raw = await this.readRawRecord(path);
    if (!raw) return undefined;
    const pointer = raw.messagePointer;
    if (pointer) {
      if (!/^[a-f0-9-]{36}$/.test(pointer.epoch) || !Number.isSafeInteger(pointer.count) || pointer.count < 0
        || !Number.isSafeInteger(pointer.parts) || pointer.parts < 0 || pointer.parts > pointer.count
        || !Number.isSafeInteger(pointer.tailCount) || pointer.tailCount < 0 || pointer.tailCount > MESSAGE_CHUNK_MAX_COUNT
        || !Number.isSafeInteger(pointer.tailBytes) || pointer.tailBytes < 0
        || (pointer.parts === 0) !== (pointer.count === 0)) {
        throw new Error(`Invalid transcript pointer: ${path}`);
      }
      const sessions = raw.sessions as Array<T & { messages: unknown[] }>;
      if (!Array.isArray(sessions) || sessions.length !== 1) throw new Error(`Invalid transcript record: ${path}`);
      const record = sessions[0]!;
      const parts: unknown[][] = new Array(pointer.parts);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, pointer.parts) }, async () => {
        while (cursor < pointer.parts) {
          const index = cursor++;
          const chunk = await readPersistedJson(this.messagePath(record.tauThreadId, pointer.epoch, index), {
            expectedVersion: this.options.version, decode: (value) => value as { messages: unknown[] }, logger: this.options.logger,
          });
          if (!chunk || chunk.readOnly || !Array.isArray(chunk.data.messages)) throw new Error(`Missing or unsupported transcript chunk: ${path} #${index}`);
          parts[index] = chunk.data.messages;
        }
      }));
      const messages = parts.flat().slice(0, pointer.count);
      if (messages.length !== pointer.count) throw new Error(`Incomplete transcript: ${path}`);
      record.messages = messages;
    }
    const data = this.options.decode(raw);
    return data;
  }

}

interface IndexedMessage { role: string; clientMessageId?: string }
const messageIndexes = new WeakMap<readonly IndexedMessage[], { count: number; firstUser?: IndexedMessage; ids: Map<string, IndexedMessage> }>();

/** Incrementally indexes the append-only transcript, without rescanning past turns. */
export function sessionMessageIndex<T extends IndexedMessage>(messages: readonly T[]): { firstUser?: T; ids: ReadonlyMap<string, T> } {
  let index = messageIndexes.get(messages);
  if (!index || index.count > messages.length) {
    index = { count: 0, ids: new Map() };
    messageIndexes.set(messages, index);
  }
  while (index.count < messages.length) {
    const message = messages[index.count++]!;
    if (!index.firstUser && message.role === "user") index.firstUser = message;
    if (message.clientMessageId && !index.ids.has(message.clientMessageId)) index.ids.set(message.clientMessageId, message);
  }
  // The cache is keyed by this exact array; every cached value came from its T elements.
  return index as unknown as { firstUser?: T; ids: ReadonlyMap<string, T> };
}
