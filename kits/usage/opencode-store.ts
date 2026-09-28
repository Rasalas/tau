import type { OutsideRecord, OutsideSession } from "./outside-logs.js";
import { timeOf } from "./outside-logs.js";

/**
 * OpenCode keeps its sessions in SQLite (`<data>/opencode.db`, or
 * `opencode-<channel>.db`): a message row per response, its JSON with the
 * tokens and OpenCode's own price. Read only, in pages, so the worker's
 * event loop breathes between them.
 */

const PAGE = 2_000;
/** A row's JSON beyond this is a conversation, not a response's metadata. */
const MAX_ROW_BYTES = 2_000_000;

interface Statement { all(...values: unknown[]): unknown[] }
interface Database { prepare(sql: string): Statement; close(): void }
type Open = (path: string) => Database;

let opener: Promise<Open | undefined> | undefined;

/** Node's own SQLite, where this runtime has it. */
export function openSqlite(): Promise<Open | undefined> {
  opener ??= import("node:sqlite").then(
    (sqlite) => (path: string) => new sqlite.DatabaseSync(path, { readOnly: true, timeout: 100 } as never) as unknown as Database,
    () => undefined,
  );
  return opener;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function columns(db: Database, table: string): Set<string> {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().flatMap((row) => text(object(row)?.name) ?? []));
  } catch {
    return new Set();
  }
}

/** A message row's response, or nothing when it is not an assistant's or used no tokens. */
export function openCodeRecord(id: string, data: Record<string, unknown>, created: number | undefined): OutsideRecord | undefined {
  if ((data.role ?? data.type) !== "assistant") return undefined;
  const tokens = object(data.tokens);
  if (!tokens) return undefined;
  const cache = object(tokens.cache);
  const input = count(tokens.input);
  // OpenCode's own stats count reasoning as output.
  const output = count(tokens.output) + count(tokens.reasoning);
  const cacheRead = count(cache?.read);
  const cacheWrite = count(cache?.write);
  const total = input + output + cacheRead + cacheWrite;
  const at = timeOf(object(data.time)?.created) ?? created;
  if (total <= 0 || at === undefined) return undefined;
  const model = object(data.model);
  const provider = text(data.providerID) ?? text(model?.providerID);
  return {
    key: `opencode:${text(data.id) ?? id}`,
    at,
    model: text(data.modelID) ?? text(model?.modelID) ?? text(model?.id) ?? "unknown model",
    ...(provider ? { provider } : {}),
    input, output, cacheRead, cacheWrite, total,
    cost: count(data.cost),
  };
}

export interface OpenCodeRead {
  sessions: OutsideSession[];
  skipped: number;
  /** The database has no table this reader knows. */
  unsupported?: boolean;
}

/** Every response since `since` (epoch ms), grouped by session; later tables replace a migrated copy. */
export async function readOpenCodeDatabase(path: string, since: number, open: Open, pause: () => Promise<void>): Promise<OpenCodeRead> {
  const db = open(path);
  try {
    const sessionColumns = columns(db, "session");
    const places = new Map<string, { cwd: string; parentId?: string }>();
    if (sessionColumns.has("id") && sessionColumns.has("directory")) {
      const parent = sessionColumns.has("parent_id") ? ", parent_id" : "";
      for (const row of db.prepare(`SELECT id, directory${parent} FROM session`).all()) {
        const item = object(row);
        const id = text(item?.id);
        if (!id) continue;
        const parentId = text(item?.parent_id);
        places.set(id, { cwd: text(item?.directory) ?? "", ...(parentId ? { parentId } : {}) });
      }
    }
    const records = new Map<string, { sessionId: string; cwd?: string; record: OutsideRecord }>();
    let skipped = 0;
    let supported = false;
    for (const table of ["message", "session_message"]) {
      const known = columns(db, table);
      if (!["id", "session_id", "data", "time_created"].every((column) => known.has(column))) continue;
      supported = true;
      const typed = known.has("type") ? ", type" : "";
      const statement = db.prepare(`SELECT id, session_id, data, time_created${typed} FROM ${table} WHERE time_created >= ? AND (id > ? OR ? = '') ORDER BY id LIMIT ${PAGE}`);
      let after = "";
      for (;;) {
        const rows = statement.all(since, after, after);
        for (const row of rows) {
          const item = object(row)!;
          const id = String(item.id);
          after = id;
          const raw = item.data;
          if (typeof raw !== "string") continue;
          if (raw.length > MAX_ROW_BYTES) { skipped += 1; continue; }
          let data: Record<string, unknown> | undefined;
          try { data = object(JSON.parse(raw)); } catch { skipped += 1; continue; }
          if (!data) continue;
          const record = openCodeRecord(id, { ...(typeof item.type === "string" && data.role === undefined && data.type === undefined ? { type: item.type } : {}), ...data }, timeOf(item.time_created));
          const cwd = text(object(data.path)?.cwd);
          if (record) records.set(record.key, { sessionId: text(item.session_id) ?? text(data.sessionID) ?? "", ...(cwd ? { cwd } : {}), record });
        }
        if (rows.length < PAGE) break;
        await pause();
      }
    }
    const sessions = new Map<string, OutsideSession>();
    for (const { sessionId, cwd, record } of records.values()) {
      let session = sessions.get(sessionId);
      if (!session) {
        const place = places.get(sessionId);
        session = { sessionId, cwd: place?.cwd || cwd || "", ...(place?.parentId ? { parentId: place.parentId } : {}), records: [] };
        sessions.set(sessionId, session);
      }
      session.records.push(record);
    }
    return { sessions: [...sessions.values()], skipped, ...(supported ? {} : { unsupported: true }) };
  } finally {
    db.close();
  }
}
