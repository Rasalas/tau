import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readPersistedJson, tryProcessLock, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";

interface SessionStoreData<T, M> {
  sessions: T[];
  models?: Record<string, M[]>;
}
interface Changes<T, M> {
  sessions?: Array<{ id: string; record?: T }>;
  models?: Array<{ id: string; models: M[] }>;
}
const LAYOUT = "thread-records";

/** Thread-keyed durable records. Writes freeze only the supplied IDs at call time. */
export class SessionStorePersistence<T extends { tauThreadId: string }, M = never> {
  private loading?: Promise<SessionStoreData<T, M> | undefined>;
  private writing: Promise<void> = Promise.resolve();
  private readonly directory: string;

  constructor(private readonly options: {
    filePath: string;
    version: number;
    decode(value: unknown): SessionStoreData<T, M> | undefined;
    encode?(data: SessionStoreData<T, M>): Record<string, unknown>;
    logger?: PersistedJsonLogger;
  }) {
    this.directory = `${options.filePath}.records`;
  }

  load(): Promise<SessionStoreData<T, M> | undefined> {
    this.loading ??= this.locked(async () => {
      const marker = await this.marker();
      if (marker && marker.data.layout !== LAYOUT && (marker.data.version ?? 0) > this.options.version) {
        return (await readPersistedJson(this.options.filePath, {
          expectedVersion: this.options.version, decode: this.options.decode, logger: this.options.logger,
        }))?.data;
      }
      await this.initialize();
      const sessions: T[] = [];
      const models: Record<string, M[]> = {};
      for (const name of await readdir(this.directory)) {
        if (!/^(session|models)-[a-f0-9]{64}\.json$/.test(name)) continue;
        const result = await this.readRecord(join(this.directory, name));
        if (!result) continue;
        if (name.startsWith("session-")) {
          if (result.sessions.length > 1 || result.sessions.some((record) => name !== `session-${createHash("sha256").update(record.tauThreadId).digest("hex")}.json`)) {
            throw new Error(`Session record does not match its storage key: ${name}`);
          }
          sessions.push(...result.sessions);
        }
        else for (const [id, entries] of Object.entries(result.models ?? {})) {
          if (name === `models-${createHash("sha256").update(id).digest("hex")}.json`) models[id] = entries;
        }
      }
      return { sessions, models };
    });
    return this.loading;
  }

  write(changes: Changes<T, M>): Promise<void> {
    const frozen = JSON.parse(JSON.stringify(changes)) as Changes<T, M>;
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await this.load();
      await this.locked(async () => {
        await this.checkMarker();
        for (const { id, record } of frozen.sessions ?? []) {
          if (record && record.tauThreadId !== id) throw new Error("Session record ID does not match its storage key");
          await this.writeRecord("session", id, { sessions: record ? [record] : [] });
        }
        for (const { id, models } of frozen.models ?? []) {
          await this.writeRecord("models", id, { sessions: [], models: { [id]: models } });
        }
      });
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

  private async marker() {
    return readPersistedJson(this.options.filePath, {
      expectedVersion: this.options.version + 1,
      decode: (value) => value as { layout?: string; version?: number },
      logger: this.options.logger,
    });
  }

  private async checkMarker(): Promise<void> {
    const marker = await this.marker();
    if (marker?.readOnly || marker?.data.layout !== LAYOUT || marker.data.version !== this.options.version + 1) {
      throw new Error(`Unsupported session store layout: ${this.options.filePath}`);
    }
    if (!(await stat(this.directory)).isDirectory()) throw new Error(`Session records directory is unavailable: ${this.directory}`);
  }

  private async initialize(): Promise<void> {
    const marker = await this.marker();
    if (marker?.data.layout === LAYOUT) {
      await this.checkMarker();
      return;
    }
    // Only the old schema can be migrated. Unknown/newer files remain untouched.
    if (marker && (marker.data.version ?? 0) > this.options.version) throw new Error(`Unsupported session store version: ${this.options.filePath}`);
    const legacy = await readPersistedJson(this.options.filePath, {
      expectedVersion: this.options.version, decode: this.options.decode, logger: this.options.logger,
    });
    if (marker && !legacy) throw new Error(`Unrecognized session store: ${this.options.filePath}`);
    if (legacy) await rm(this.directory, { recursive: true, force: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: Array<{ kind: "session" | "models"; id: string; data: SessionStoreData<T, M> }> = [
      ...(legacy?.data.sessions ?? []).map((record) => ({ kind: "session" as const, id: record.tauThreadId, data: { sessions: [record] } })),
      ...Object.entries(legacy?.data.models ?? {}).map(([id, models]) => ({ kind: "models" as const, id, data: { sessions: [], models: { [id]: models } } })),
    ];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, records.length) }, async () => {
      while (cursor < records.length) {
        const { kind, id, data } = records[cursor++]!;
        await this.writeRecord(kind, id, data);
      }
    });
    // Drain every worker even on failure before releasing the migration lock.
    // Otherwise a retry could clear the directory while an old worker still writes.
    const results = await Promise.allSettled(workers);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (legacy) {
      await copyFile(this.options.filePath, `${this.options.filePath}.legacy`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await chmod(`${this.options.filePath}.legacy`, 0o600);
    }
    // Publishing last makes interrupted migrations retry from the intact old file.
    // Older builds see a newer schema and cannot overwrite the migrated store.
    await writePersistedJson(this.options.filePath, this.options.version + 1, { layout: LAYOUT }, { logger: this.options.logger });
  }

  private async readRecord(path: string): Promise<SessionStoreData<T, M> | undefined> {
    return (await readPersistedJson(path, {
      expectedVersion: this.options.version, decode: this.options.decode, logger: this.options.logger,
    }))?.data;
  }

  private async writeRecord(kind: "session" | "models", id: string, data: SessionStoreData<T, M>): Promise<void> {
    const key = createHash("sha256").update(id).digest("hex");
    const path = join(this.directory, `${kind}-${key}.json`);
    await this.readRecord(path); // Establish the helper's failed-read/newer-schema write guard.
    await writePersistedJson(path, this.options.version, this.options.encode?.(data) ?? { ...data }, { logger: this.options.logger });
  }
}
