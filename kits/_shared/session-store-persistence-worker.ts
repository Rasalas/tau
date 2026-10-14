/** One immutable, ordered history row, encoded before it leaves the caller. */
export interface SqliteHistoryRow { ordinal: number; payload: string }
export interface SqliteHistoryChange {
  replace: boolean;
  start: number;
  next: number;
  rows: SqliteHistoryRow[];
}
export interface SqliteSessionChange {
  id: string;
  version: number;
  revision: string;
  expectedRevision?: string;
  expectedAbsent?: boolean;
  metadata?: string;
  summary?: string;
  hasMessages: boolean;
  messageCount: number;
  messages: SqliteHistoryChange;
  hasUsage: boolean;
  usage: SqliteHistoryChange;
}
export interface SqliteChanges {
  sessions: SqliteSessionChange[];
  models: Array<{ id: string; version: number; payload: string }>;
}
export interface SqliteSessionRead {
  id: string;
  version: number;
  revision: string;
  usageStart: number;
  usageNext: number;
  raw: unknown;
  messageCount: number;
  summary?: { version?: number; firstUser?: unknown; tallies?: unknown[] };
  hydrated: boolean;
  usageHydrated: boolean;
}
export interface SqliteStoreRead {
  sessions: SqliteSessionRead[];
  models: Array<{ id: string; raw: unknown }>;
}

/**
 * Embedded in a host bundle, then serialized into a CJS worker. Everything
 * this function uses is local or a builtin imported through its parameter.
 * A parameter shadows require so esbuild cannot capture an outer ESM helper.
 */
export function sessionStoreSqliteWorkerMain(requireBuiltin: NodeRequire): void {
  const { parentPort, workerData } = requireBuiltin("node:worker_threads") as typeof import("node:worker_threads");
  const fs = requireBuiltin("node:fs") as typeof import("node:fs");
  const { dirname } = requireBuiltin("node:path") as typeof import("node:path");
  const port = parentPort!;
  const path = workerData.path as string;
  const applicationId = 0x54415553;
  const schemaVersion = 1;
  let database: import("node:sqlite").DatabaseSync | undefined;
  let identity: { dev: number; ino: number } | undefined;

  const permissions = () => {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try { fs.chmodSync(file, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  const open = (create: boolean) => {
    if (database) {
      const current = fs.statSync(path);
      if (!identity || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("SQLite session database was replaced; reload the store");
      return database;
    }
    let sqlite: typeof import("node:sqlite");
    try { sqlite = requireBuiltin("node:sqlite") as typeof import("node:sqlite"); }
    catch { throw new Error("SQLite session storage requires Node.js 22.13 or later."); }
    if (typeof sqlite.DatabaseSync !== "function") throw new Error("SQLite session storage requires Node.js 22.13 or later.");
    if (!fs.existsSync(path)) {
      if (!create) throw new Error(`SQLite session database is unavailable: ${path}`);
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fs.chmodSync(dirname(path), 0o700);
      fs.closeSync(fs.openSync(path, "wx", 0o600));
    }
    const db = new sqlite.DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      const app = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      if ((version !== 0 && version !== schemaVersion) || (app !== 0 && app !== applicationId)
        || (!create && (version !== schemaVersion || app !== applicationId))) {
        throw new Error(`Unsupported SQLite session database schema: ${path}`);
      }
      if (version === 0) {
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          BEGIN IMMEDIATE;
          CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE sessions (
            thread_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL,
            metadata TEXT NOT NULL, revision TEXT NOT NULL,
            has_messages INTEGER NOT NULL, message_count INTEGER NOT NULL,
            has_usage INTEGER NOT NULL, usage_start INTEGER NOT NULL, usage_next INTEGER NOT NULL
          ) WITHOUT ROWID;
          CREATE TABLE messages (
            thread_id TEXT NOT NULL REFERENCES sessions(thread_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY (thread_id, ordinal)
          ) WITHOUT ROWID;
          CREATE TABLE usage_turns (
            thread_id TEXT NOT NULL REFERENCES sessions(thread_id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY (thread_id, ordinal)
          ) WITHOUT ROWID;
          CREATE TABLE models (instance_id TEXT PRIMARY KEY, record_version INTEGER NOT NULL, payload TEXT NOT NULL) WITHOUT ROWID;
          PRAGMA application_id = ${applicationId};
          PRAGMA user_version = ${schemaVersion};
          COMMIT;
        `);
      } else {
        const mode = String(db.prepare("PRAGMA journal_mode").get()!.journal_mode);
        if (mode !== "wal") throw new Error(`SQLite session database is not in WAL mode: ${path}`);
        db.exec("PRAGMA synchronous = FULL;");
      }
      // Additive, revision-bound summaries also tolerate an older writer: its
      // next commit invalidates the summary by changing the session revision.
      db.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
        thread_id TEXT PRIMARY KEY REFERENCES sessions(thread_id) ON DELETE CASCADE,
        revision TEXT NOT NULL, payload TEXT NOT NULL
      ) WITHOUT ROWID`);
      permissions();
      identity = fs.statSync(path);
      database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  };

  const transaction = <T>(action: (db: import("node:sqlite").DatabaseSync) => T): T => {
    const db = open(false);
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = action(db);
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Keep the original failure. */ }
      throw error;
    } finally { permissions(); }
  };

  const write = (changes: SqliteChanges, importing = false, importDigest?: string) => {
    return transaction((db) => {
      if (importDigest !== undefined) {
        const receipt = db.prepare("SELECT value FROM store_meta WHERE key = 'import_digest'").get()?.value;
        if (receipt !== undefined) {
          if (receipt !== importDigest) throw new Error("Legacy session source changed after SQLite migration");
          return;
        }
      }
      const existing = db.prepare("SELECT record_version, revision FROM sessions WHERE thread_id = ?");
      const remove = db.prepare("DELETE FROM sessions WHERE thread_id = ?");
      const upsert = db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET record_version=excluded.record_version, metadata=excluded.metadata,
        revision=excluded.revision, has_messages=excluded.has_messages, message_count=excluded.message_count,
        has_usage=excluded.has_usage, usage_start=excluded.usage_start, usage_next=excluded.usage_next`);
      const saveSummary = db.prepare("INSERT INTO session_summaries VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload");
      const carrySummary = db.prepare("UPDATE session_summaries SET revision=? WHERE thread_id=? AND revision=?");
      const insertMessage = db.prepare("INSERT INTO messages VALUES (?, ?, ?)");
      const insertUsage = db.prepare("INSERT INTO usage_turns VALUES (?, ?, ?) ON CONFLICT(thread_id,ordinal) DO UPDATE SET payload=excluded.payload");
      const clearMessages = db.prepare("DELETE FROM messages WHERE thread_id = ?");
      const clearUsage = db.prepare("DELETE FROM usage_turns WHERE thread_id = ?");
      const trimUsage = db.prepare("DELETE FROM usage_turns WHERE thread_id = ? AND ordinal < ?");
      for (const change of changes.sessions) {
        const previous = existing.get(change.id);
        if (!importing && previous && Number(previous.record_version) > change.version) {
          throw new Error(`Session '${change.id}' is version ${previous.record_version}; refusing to overwrite it with version ${change.version}`);
        }
        if (change.expectedAbsent && previous) throw new Error("Session was restored or created by another writer; reload the store");
        if (change.expectedRevision !== undefined && previous?.revision !== change.expectedRevision) {
          throw new Error("Session transcript changed in another writer; reload before appending");
        }
        if (change.metadata === undefined) { remove.run(change.id); continue; }
        const metadata = JSON.parse(change.metadata) as { sessions?: Array<{ tauThreadId?: unknown }> };
        if (metadata.sessions?.length !== 1 || metadata.sessions[0]?.tauThreadId !== change.id) {
          throw new Error("Session record ID does not match its storage key");
        }
        upsert.run(change.id, change.version, change.metadata, change.revision, Number(change.hasMessages), change.messageCount,
          Number(change.hasUsage), change.usage.start, change.usage.next);
        if (change.summary !== undefined) saveSummary.run(change.id, change.revision, change.summary);
        else if (previous) carrySummary.run(change.revision, change.id, previous.revision);
        if (change.messages.replace) clearMessages.run(change.id);
        for (const row of change.messages.rows) insertMessage.run(change.id, row.ordinal, row.payload);
        if (change.usage.replace) clearUsage.run(change.id);
        else if (change.usage.start > 0) trimUsage.run(change.id, change.usage.start);
        for (const row of change.usage.rows) insertUsage.run(change.id, row.ordinal, row.payload);
      }
      const modelVersion = db.prepare("SELECT record_version FROM models WHERE instance_id = ?");
      const saveModel = db.prepare("INSERT INTO models VALUES (?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET record_version=excluded.record_version,payload=excluded.payload");
      for (const model of changes.models) {
        const version = modelVersion.get(model.id)?.record_version;
        if (!importing && version !== undefined && Number(version) > model.version) throw new Error(`Model catalog is version ${version}; refusing to overwrite it with version ${model.version}`);
        saveModel.run(model.id, model.version, model.payload);
      }
      if (importDigest !== undefined) db.prepare("INSERT INTO store_meta VALUES ('import_digest', ?)").run(importDigest);
    });
  };

  const load = (metadataOnly = false, threadId?: string, usageOnly = false, threadIds?: string[]): SqliteStoreRead => {
    const db = open(false);
    const messageRows = db.prepare("SELECT ordinal,payload FROM messages WHERE thread_id = ? ORDER BY ordinal");
    const usageRows = db.prepare("SELECT ordinal,payload FROM usage_turns WHERE thread_id = ? ORDER BY ordinal");
    // A read transaction prevents another process's commit from mixing metadata
    // from one revision with history from the next.
    db.exec("BEGIN");
    try {
      const sql = `SELECT sessions.*, session_summaries.payload AS summary FROM sessions
        LEFT JOIN session_summaries ON sessions.thread_id = session_summaries.thread_id AND sessions.revision = session_summaries.revision`;
      const rows = threadId === undefined ? db.prepare(sql).all() : db.prepare(`${sql} WHERE sessions.thread_id = ?`).all(threadId);
      const selected = threadIds ? new Set(threadIds) : undefined;
      const sessions = rows.filter(row => !selected || selected.has(String(row.thread_id))).map((row): SqliteSessionRead => {
        const id = String(row.thread_id);
        const raw = JSON.parse(String(row.metadata)) as { sessions: Array<Record<string, unknown>> };
        if (raw.sessions?.length !== 1 || raw.sessions[0]?.tauThreadId !== id) throw new Error(`Session record does not match its storage key: ${id}`);
        const record = raw.sessions[0]!;
        let summary = row.summary === null ? undefined : JSON.parse(String(row.summary));
        if (workerData.summaryVersion !== undefined && summary?.version !== workerData.summaryVersion) summary = undefined;
        const hydrated = !usageOnly && (!metadataOnly || summary === undefined);
        const usageHydrated = hydrated || usageOnly;
        if (hydrated && row.has_messages) {
          const messages = messageRows.all(id);
          if (messages.length !== Number(row.message_count) || messages.some((message, index) => Number(message.ordinal) !== index)) {
            throw new Error(`Incomplete SQLite transcript: ${id}`);
          }
          record.messages = messages.map((message) => JSON.parse(String(message.payload)));
        }
        if (usageHydrated && row.has_usage) {
          const usage = usageRows.all(id);
          const start = Number(row.usage_start), next = Number(row.usage_next);
          if (usage.length !== next - start || usage.some((turn, index) => Number(turn.ordinal) !== start + index)) throw new Error(`Incomplete SQLite usage history: ${id}`);
          record.usageTurns = usage.map((turn) => JSON.parse(String(turn.payload)));
        }
        if (!hydrated && row.has_messages) record.messages = summary?.firstUser ? [summary.firstUser] : [];
        return { messageCount: Number(row.message_count), summary, hydrated, usageHydrated, id, version: Number(row.record_version), revision: String(row.revision), usageStart: Number(row.usage_start), usageNext: Number(row.usage_next), raw };
      });
      const models = threadId !== undefined || threadIds !== undefined || usageOnly ? [] : db.prepare("SELECT instance_id,payload FROM models").all().map((row) => ({ id: String(row.instance_id), raw: JSON.parse(String(row.payload)) }));
      db.exec("COMMIT");
      return { sessions, models };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };

  port.on("message", (request: { id: number; operation: string; changes?: SqliteChanges; digest?: string; threadId?: string; threadIds?: string[]; summaries?: Array<{ id: string; revision: string; payload: string }> }) => {
    try {
      let value: unknown;
      if (request.operation === "initialize") {
        const db = open(true);
        const digest = db.prepare("SELECT value FROM store_meta WHERE key = 'import_digest'").get()?.value;
        if (digest !== undefined) {
          if (digest !== request.digest) throw new Error("Legacy session source changed after SQLite migration; refusing to overwrite the migrated database");
        } else {
          write(request.changes!, true, request.digest!);
        }
      } else if (request.operation === "load") value = load();
      else if (request.operation === "metadata") value = load(true);
      else if (request.operation === "histories") value = load(false, undefined, false, request.threadIds);
      else if (request.operation === "usage") value = load(true, undefined, true);
      else if (request.operation === "history") value = load(false, request.threadId);
      else if (request.operation === "summaries") transaction((db) => {
        const save = db.prepare("INSERT INTO session_summaries VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload");
        for (const summary of request.summaries!) {
          if (db.prepare("SELECT revision FROM sessions WHERE thread_id = ?").get(summary.id)?.revision !== summary.revision) throw new Error("Session changed while publishing its metadata summary");
          save.run(summary.id, summary.revision, summary.payload);
        }
      });
      else if (request.operation === "write") write(request.changes!);
      else if (request.operation === "close") { database?.close(); database = undefined; }
      else throw new Error("Unknown SQLite session operation");
      port.postMessage({ id: request.id, value });
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
