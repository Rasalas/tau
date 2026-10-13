import { setTimeout as delay } from "node:timers/promises";
import { readPersistedJson, tryProcessLock, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";

interface SessionStoreData<T, M> {
  sessions: T[];
  models?: Record<string, M[]>;
}

interface Snapshot {
  sessions: Map<string, string>;
  models: Map<string, string>;
}

function snapshot<T extends { tauThreadId: string }, M>(data: SessionStoreData<T, M>): Snapshot {
  return {
    sessions: new Map(data.sessions.map((record) => [record.tauThreadId, JSON.stringify(record)])),
    models: new Map(Object.entries(data.models ?? {}).map(([id, models]) => [id, JSON.stringify(models)])),
  };
}

function merge(previous: Map<string, string>, next: Map<string, string>, stored: Map<string, string>): Map<string, string> {
  for (const id of previous.keys()) if (!next.has(id)) stored.delete(id);
  for (const [id, value] of next) if (previous.get(id) !== value) stored.set(id, value);
  return stored;
}

/** Applies only this store's changed IDs to a fresh disk read under an OS-held lock. */
export class SessionStorePersistence<T extends { tauThreadId: string }, M = never> {
  private baseline: Snapshot = { sessions: new Map(), models: new Map() };
  private loading?: Promise<SessionStoreData<T, M> | undefined>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    filePath: string;
    version: number;
    decode(value: unknown): SessionStoreData<T, M> | undefined;
    encode?(data: SessionStoreData<T, M>): Record<string, unknown>;
    logger?: PersistedJsonLogger;
  }) {}

  load(): Promise<SessionStoreData<T, M> | undefined> {
    this.loading ??= this.read().then((data) => {
      this.baseline = snapshot(data ?? { sessions: [] });
      return data;
    });
    return this.loading;
  }

  write(data: SessionStoreData<T, M>): Promise<void> {
    // Freeze at call time: queued writes must not observe later in-memory mutations.
    const next = snapshot(data);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await this.load();
      const deadline = Date.now() + 10_000;
      let lock;
      while (!(lock = await tryProcessLock(`${this.options.filePath}.lock`, { pid: process.pid, startedAt: new Date().toISOString() }))) {
        if (Date.now() >= deadline) throw new Error(`Session store is busy: ${this.options.filePath}`);
        await delay(25);
      }
      try {
        const latest = await this.read();
        const stored = snapshot(latest ?? { sessions: [] });
        const sessions = [...merge(this.baseline.sessions, next.sessions, stored.sessions).values()].map((value) => JSON.parse(value) as T);
        const models = Object.fromEntries([...merge(this.baseline.models, next.models, stored.models)].map(([id, value]) => [id, JSON.parse(value) as M[]]));
        const merged = { sessions, ...(data.models || latest?.models ? { models } : {}) };
        await writePersistedJson(this.options.filePath, this.options.version, this.options.encode?.(merged) ?? merged, { logger: this.options.logger });
        this.baseline = next;
      } finally {
        lock.release();
      }
    });
    return this.writing;
  }

  private async read(): Promise<SessionStoreData<T, M> | undefined> {
    return (await readPersistedJson(this.options.filePath, {
      expectedVersion: this.options.version,
      decode: this.options.decode,
      logger: this.options.logger,
    }))?.data;
  }
}
