import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { readPersistedJson, tryProcessLock, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";
import { sessionStoreSqliteWorkerMain, type SqliteChanges, type SqliteSessionChange, type SqliteStoreRead } from "./session-store-persistence-worker.js";

interface SessionStoreData<T, M> { sessions: T[]; models?: Record<string, M[]> }
interface Changes<T, M> {
  sessions?: Array<{ id: string; record?: T; appendOnly?: boolean }>;
  models?: Array<{ id: string; models: M[] }>;
}
const LAYOUT = "sqlite-sessions";
interface Snapshot { summary?: string; revision: string; messages?: unknown[]; count: number; usage: unknown[]; start: number; next: number }
interface MessagePointer { epoch: string; count: number; parts: number; tailCount: number; tailBytes: number }
const MESSAGE_CHUNK_MAX_COUNT = 64;

/** Durable changed-row transactions; synchronous SQLite work stays off the host loop. */
export class SessionStorePersistence<T extends { tauThreadId: string }, M = never> {
  readonly databasePath: string;
  private readOnlyData = false;
  private databaseIdentity?: { dev: number; ino: number };
  private loading?: Promise<SessionStoreData<T, M> | undefined>;
  private readonly histories = new Map<string, T>();
  private readonly hydrating = new Map<string, Promise<T | undefined>>();
  private readonly unloaded = new Set<string>();
  private readonly committed = new Set<string>();
  private readonly invalid = new Set<string>();
  private readonly summaries = new Map<string, { firstUser?: unknown; tallies?: unknown[] }>();
  private writing: Promise<void> = Promise.resolve();
  private readonly snapshots = new Map<string, Snapshot>();
  private generation = 0;
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private disposed = false;
  private closing?: Promise<void>;
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
    immutableUsageTurns?: boolean;
    summarizeUsage?(record: T): unknown[] | undefined;
    /** Invalidate summaries when a runtime changes how persisted usage is decoded. */
    summaryVersion?: number;
    logger?: PersistedJsonLogger;
  }) { this.databasePath = `${options.filePath}.sqlite`; this.directory = `${options.filePath}.records`; }

  private request(operation: string, values: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Session store is disposed"));
    clearTimeout(this.timer);
    if (!this.worker) {
      const worker = new Worker(`import("node:module").then(({ createRequire }) => (${sessionStoreSqliteWorkerMain.toString()})(createRequire(process.execPath)))`, { eval: true, workerData: { path: this.databasePath, summaryVersion: this.options.summaryVersion } });
      this.worker = worker;
      worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
        const pending = this.requests.get(reply.id);
        this.requests.delete(reply.id);
        if (reply.error) pending?.reject(new Error(reply.error)); else pending?.resolve(reply.value);
        if (!this.requests.size && this.worker === worker) {
          worker.unref();
          this.timer = setTimeout(() => { if (this.worker === worker && !this.requests.size) { this.worker = undefined; void worker.terminate(); } }, 30_000);
          this.timer.unref();
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
      });
    });
    this.writing = release;
    return release;
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.flushAndRelease().finally(() => { this.disposed = true; });
    return this.closing;
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
    await this.loadMetadata();
    await Promise.all(ids.map(id => this.hydrating.get(id)));
    return this.locked(async () => {
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

  messageCount(id: string): number | undefined { return this.snapshots.get(id)?.count; }
  isUnloaded(id: string): boolean { return this.unloaded.has(id); }
  usageTallies(id: string): unknown[] | undefined { return this.summaries.get(id)?.tallies?.map(tally => ({ ...tally as object })); }

  /** One read transaction returns current metadata and exactly this history. */
  loadSession(id: string): Promise<T | undefined> {
    if (this.closing || this.disposed) return Promise.reject(new Error("Session store is disposed"));
    if (this.invalid.has(id)) return Promise.reject(new Error("Earlier session write failed; reload the store before appending"));
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
    this.summaries.delete(id);
    this.committed.delete(id);
  }

  private async readSession(id: string): Promise<T | undefined> {
    await this.loadData();
    if (!this.unloaded.has(id)) return this.histories.get(id);
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
      this.options.publishHydrated?.(id, record);
      this.unloaded.delete(id);
    } else {
      this.options.publishHydrated?.(id, undefined);
      this.forgetAbsent(id);
    }
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
    this.committed.add(row.id);
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
    });
    return this.loading;
  }

  private encode(data: SessionStoreData<T, M>): string { return JSON.stringify(this.options.encode?.(data) ?? data); }
  private freeze(id: string, record: T | undefined, appendOnly = false, version = this.options.version): SqliteSessionChange {
    if (record && this.unloaded.has(id)) throw new Error(`Session '${id}' history is not loaded; read it before writing`);
    if (appendOnly && this.invalid.has(id)) throw new Error("Earlier session write failed; reload the store before appending");
    const prior = appendOnly ? this.snapshots.get(id) : undefined;
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
    const result: SqliteSessionChange = { id, version, revision, expectedRevision: prior?.revision, expectedAbsent: appendOnly && record !== undefined && prior === undefined,
      summary: summary !== prior?.summary ? summary : undefined,
      metadata: record ? this.encode({ sessions: [{ ...record, ...(messages ? { messages: [] } : {}), ...(history?.usageTurns ? { usageTurns: [] } : {}) }] }) : undefined,
      hasMessages: Array.isArray(messages), messageCount: messages?.length ?? 0,
      messages: { replace: !reuse, start: 0, next: messages?.length ?? 0, rows: (messages ?? []).slice(reuse ? prior!.count : 0).map((message, index) => ({ ordinal: (reuse ? prior!.count : 0) + index, payload: JSON.stringify(this.options.encodeMessage?.(message) ?? message) })) },
      hasUsage: Array.isArray(history?.usageTurns), usage: { replace: usageReplace, start: usageStart, next: usageNext, rows: usageRows } };
    if (record) { this.histories.set(id, record); this.summaries.set(id, JSON.parse(summary!)); this.snapshots.set(id, { revision, summary, messages, count: messages?.length ?? 0, usage: usage.slice(), start: usageStart, next: usageNext }); }
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
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (generation !== this.generation) throw new Error("Earlier session write failed; retry the update");
      await this.loadData();
      await this.locked(async () => { await this.checkMarker(); await this.request("write", { changes: frozen }); });
      for (const change of frozen.sessions) { if (change.metadata) this.committed.add(change.id); else this.committed.delete(change.id); }
    }).catch((error) => { if (generation === this.generation) { this.generation++; for (const id of this.committed) this.invalid.add(id); this.snapshots.clear(); } throw error; });
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
        const pendingSummary = this.summaries.get(record.tauThreadId);
        changes.sessions.push(this.freeze(record.tauThreadId, record, false, version));
        if (pending) {
          this.snapshots.set(record.tauThreadId, pending);
          if (pendingHistory) this.histories.set(record.tauThreadId, pendingHistory);
          if (pendingSummary) this.summaries.set(record.tauThreadId, pendingSummary);
        } else { this.snapshots.delete(record.tauThreadId); this.histories.delete(record.tauThreadId); }
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
