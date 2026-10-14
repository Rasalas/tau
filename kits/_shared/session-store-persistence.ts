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
interface Snapshot { revision: string; messages?: unknown[]; count: number; usage: unknown[]; start: number; next: number }
interface MessagePointer { epoch: string; count: number; parts: number; tailCount: number; tailBytes: number }
const MESSAGE_CHUNK_MAX_COUNT = 64;

/** Durable changed-row transactions; synchronous SQLite work stays off the host loop. */
export class SessionStorePersistence<T extends { tauThreadId: string }, M = never> {
  readonly databasePath: string;
  private loading?: Promise<SessionStoreData<T, M> | undefined>;
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
    immutableUsageTurns?: boolean;
    logger?: PersistedJsonLogger;
  }) { this.databasePath = `${options.filePath}.sqlite`; this.directory = `${options.filePath}.records`; }

  private request(operation: string, values: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Session store is disposed"));
    clearTimeout(this.timer);
    if (!this.worker) {
      const worker = new Worker(`import("node:module").then(({ createRequire }) => (${sessionStoreSqliteWorkerMain.toString()})(createRequire(process.execPath)))`, { eval: true, workerData: { path: this.databasePath } });
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

  load(): Promise<SessionStoreData<T, M> | undefined> {
    if (this.closing || this.disposed) return Promise.reject(new Error("Session store is disposed"));
    return this.loadData();
  }

  private loadData(): Promise<SessionStoreData<T, M> | undefined> {
    this.loading ??= this.locked(async () => {
      const marker = await this.marker();
      if (marker && marker.data.layout !== LAYOUT && marker.data.layout !== "thread-records" && marker.data.layout !== "thread-records-messages"
        && (marker.data.version ?? 0) > this.options.version) {
        return (await readPersistedJson(this.options.filePath, { expectedVersion: this.options.version,
          decode: this.options.decode, logger: this.options.logger }))?.data;
      }
      await this.initialize();
      const loaded = await this.request("load") as SqliteStoreRead;
      const sessions: T[] = [], models: Record<string, M[]> = {};
      for (const row of loaded.sessions) {
        const data = this.options.decode(row.raw);
        if (!data) throw new Error(`Invalid SQLite session: ${row.id}`);
        sessions.push(...data.sessions);
        const record = data.sessions[0] as T & { messages?: unknown[]; usageTurns?: unknown[] };
        const storedUsage = (row.raw as { sessions: Array<{ usageTurns?: unknown[] }> }).sessions[0]?.usageTurns ?? [];
        // A decoder may migrate cumulative counters into deltas. Only unchanged
        // rows may reuse decoded identities; migrated rows must be written back.
        const usage = isDeepStrictEqual(storedUsage, record?.usageTurns ?? []) ? record?.usageTurns ?? [] : storedUsage;
        if (record && !this.snapshots.has(row.id)) this.snapshots.set(row.id, { revision: row.revision, messages: record.messages,
          count: record.messages?.length ?? 0, usage: usage.slice(), start: row.usageStart, next: row.usageNext });
      }
      for (const row of loaded.models) {
        const entries = this.options.decode(row.raw)?.models?.[row.id];
        if (!entries) throw new Error(`Invalid SQLite model catalog: ${row.id}`);
        models[row.id] = entries;
      }
      // Full hydration temporarily grows the reader heap. Release that worker
      // immediately; the first later mutation opens a small retained writer.
      await this.closeWorker();
      return { sessions, models };
    });
    return this.loading;
  }

  private encode(data: SessionStoreData<T, M>): string { return JSON.stringify(this.options.encode?.(data) ?? data); }
  private freeze(id: string, record: T | undefined, appendOnly = false, version = this.options.version): SqliteSessionChange {
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
    const result: SqliteSessionChange = { id, version, revision, expectedRevision: reuse ? prior!.revision : undefined,
      metadata: record ? this.encode({ sessions: [{ ...record, ...(messages ? { messages: [] } : {}), ...(history?.usageTurns ? { usageTurns: [] } : {}) }] }) : undefined,
      hasMessages: Array.isArray(messages), messageCount: messages?.length ?? 0,
      messages: { replace: !reuse, start: 0, next: messages?.length ?? 0, rows: (messages ?? []).slice(reuse ? prior!.count : 0).map((message, index) => ({ ordinal: (reuse ? prior!.count : 0) + index, payload: JSON.stringify(this.options.encodeMessage?.(message) ?? message) })) },
      hasUsage: Array.isArray(history?.usageTurns), usage: { replace: usageReplace, start: usageStart, next: usageNext, rows: usageRows } };
    if (record) this.snapshots.set(id, { revision, messages, count: messages?.length ?? 0, usage: usage.slice(), start: usageStart, next: usageNext });
    else this.snapshots.delete(id);
    return result;
  }

  write(changes: Changes<T, M>): Promise<void> {
    if (this.disposed || this.closing) return Promise.reject(new Error("Session store is disposed"));
    const generation = this.generation;
    const frozen: SqliteChanges = { sessions: (changes.sessions ?? []).map(({ id, record, appendOnly }) => this.freeze(id, record, appendOnly)),
      models: (changes.models ?? []).map(({ id, models }) => ({ id, version: this.options.version, payload: this.encode({ sessions: [], models: { [id]: models } }) })) };
    this.writing = this.writing.catch(() => undefined).then(async () => {
      if (generation !== this.generation) throw new Error("Earlier session write failed; retry the update");
      await this.loadData();
      await this.locked(async () => { await this.checkMarker(); await this.request("write", { changes: frozen }); });
    }).catch((error) => { if (generation === this.generation) { this.generation++; this.snapshots.clear(); } throw error; });
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
    if (!(await stat(this.databasePath)).isFile()) throw new Error(`SQLite session database is unavailable: ${this.databasePath}`);
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
        changes.sessions.push(this.freeze(record.tauThreadId, record, false, version));
        if (pending) this.snapshots.set(record.tauThreadId, pending); else this.snapshots.delete(record.tauThreadId);
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
