import type { OutsideRecord } from "./outside-logs.js";
import { timeOf } from "./outside-logs.js";

/**
 * OpenCode keeps its sessions in SQLite (`<data>/opencode.db`, or
 * `opencode-<channel>.db`): a message row per response, its JSON with the
 * tokens and OpenCode's own price. Read only, in pages, so the worker's
 * event loop breathes between them, and only the fields a count needs:
 * SQLite takes them out of the JSON, so a large row never reaches the heap.
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

/** The fields of a message row's JSON this reader needs, pulled out by SQLite; the rest never reaches JavaScript. */
const FIELDS = {
  role: "$.role",
  kind: "$.type",
  input: "$.tokens.input",
  output: "$.tokens.output",
  reasoning: "$.tokens.reasoning",
  cacheRead: "$.tokens.cache.read",
  cacheWrite: "$.tokens.cache.write",
  hasTokens: "$.tokens",
  created: "$.time.created",
  dataId: "$.id",
  providerId: "$.providerID",
  modelProviderId: "$.model.providerID",
  modelId: "$.modelID",
  modelModelId: "$.model.modelID",
  modelIdAlt: "$.model.id",
  cost: "$.cost",
  sessionId: "$.sessionID",
  cwd: "$.path.cwd",
} as const;

type Fields = Partial<Record<keyof typeof FIELDS, unknown>> & { type?: unknown };
const NAMES = Object.keys(FIELDS) as Array<keyof typeof FIELDS>;

/** A message row's response, or nothing when it is not an assistant's or used no tokens. */
export function openCodeRecord(id: string, row: Fields, created: number | undefined): OutsideRecord | undefined {
  if ((row.role ?? row.kind ?? row.type) !== "assistant") return undefined;
  if (row.hasTokens === null || row.hasTokens === undefined) return undefined;
  const input = count(row.input);
  // OpenCode's own stats count reasoning as output.
  const output = count(row.output) + count(row.reasoning);
  const cacheRead = count(row.cacheRead);
  const cacheWrite = count(row.cacheWrite);
  const total = input + output + cacheRead + cacheWrite;
  const at = timeOf(row.created) ?? created;
  if (total <= 0 || at === undefined) return undefined;
  const provider = text(row.providerId) ?? text(row.modelProviderId);
  return {
    key: `opencode:${text(row.dataId) ?? id}`,
    at,
    model: text(row.modelId) ?? text(row.modelModelId) ?? text(row.modelIdAlt) ?? "unknown model",
    ...(provider ? { provider } : {}),
    input, output, cacheRead, cacheWrite, total,
    cost: count(row.cost),
  };
}

/** Where a table was read to: every row up to `rowid` (whose id was `id`) is counted for good. */
export interface OpenCodeCursor {
  rowid: number;
  id: string;
}

export interface OpenCodeRead {
  /** Where each session ran, and what it was forked from. */
  sessions: Map<string, { cwd: string; parentId?: string }>;
  skipped: number;
  /** Per table, how far rows are final. */
  cursors: Record<string, OpenCodeCursor>;
  /** The database has no table this reader knows. */
  unsupported?: boolean;
}

export interface OpenCodeReadOptions {
  /** Epoch ms: older rows are not read. */
  since: number;
  /** Rows created before this are final once read; later ones may still change and are read again next time. */
  finalBefore: number;
  /** From an earlier read: rows up to these are counted already. */
  cursors?: Record<string, OpenCodeCursor>;
  /** The cursors no longer fit the database (a vacuum numbered its rows anew): everything is read again. */
  onRestart?(): void;
}

/**
 * Hands every response to `add` with its session and whether it is final,
 * page by page in insertion order: from where an earlier read's final rows
 * end, so a database that grew is read only past them. Rows created lately
 * may still be written (a response streams its tokens in) and are read again
 * next time. A row the newer table holds counts there; its migrated copy in
 * the older one is skipped.
 */
export async function readOpenCodeDatabase(path: string, options: OpenCodeReadOptions, open: Open, pause: () => Promise<void>, add: (sessionId: string, record: OutsideRecord, final: boolean) => void): Promise<OpenCodeRead> {
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
    let skipped = 0;
    let supported = false;
    const cursors: Record<string, OpenCodeCursor> = {};
    const tables = ["session_message", "message"].filter((table) => ["id", "session_id", "data", "time_created"].every((column) => columns(db, table).has(column)));
    const idAt = (table: string, rowid: number) => text(object(db.prepare(`SELECT id FROM ${table} WHERE rowid = ?`).all(rowid)[0])?.id);
    let start = options.cursors ?? {};
    if (Object.entries(start).some(([table, cursor]) => !tables.includes(table) || idAt(table, cursor.rowid) !== cursor.id)) {
      start = {};
      options.onRestart?.();
    }
    for (const table of tables) {
      supported = true;
      const known = columns(db, table);
      const typed = known.has("type") ? ", type" : "";
      let cursor = start[table];
      const copy = table === "message" && tables.includes("session_message") ? " AND NOT EXISTS (SELECT 1 FROM session_message s WHERE s.id = message.id)" : "";
      // One pass over each row's JSON; an oversized or broken row comes back as NULL and is skipped.
      const paths = Object.values(FIELDS).map((pointer) => `'${pointer}'`).join(", ");
      const statement = db.prepare(
        `SELECT rowid AS rid, id, session_id, time_created${typed}, CASE WHEN length(data) > ${MAX_ROW_BYTES} THEN NULL WHEN json_valid(data) THEN json_extract(data, ${paths}) END AS fields `
        + `FROM ${table} WHERE rowid > ? AND time_created >= ?${copy} ORDER BY rowid LIMIT ${PAGE}`,
      );
      let after = cursor?.rowid ?? 0;
      // Rows are final up to the first one that may still change; nothing after it is.
      let final = true;
      for (;;) {
        const rows = statement.all(after, options.since) as Array<{ rid: number; id: unknown; session_id: unknown; time_created: unknown; type?: unknown; fields: unknown }>;
        for (const row of rows) {
          after = row.rid;
          const id = String(row.id);
          const created = timeOf(row.time_created);
          if (final && (created === undefined || created >= options.finalBefore)) final = false;
          if (final) cursor = { rowid: row.rid, id };
          let values: unknown[] | undefined;
          try { values = typeof row.fields === "string" ? JSON.parse(row.fields) as unknown[] : undefined; } catch { values = undefined; }
          if (!Array.isArray(values)) { skipped += 1; continue; }
          const fields: Fields = { type: row.type };
          NAMES.forEach((name, index) => { fields[name] = values![index]; });
          const record = openCodeRecord(id, fields, created);
          if (!record) continue;
          const sessionId = text(row.session_id) ?? text(fields.sessionId) ?? "";
          const cwd = text(fields.cwd);
          if (cwd && !places.has(sessionId)) places.set(sessionId, { cwd });
          add(sessionId, record, final);
        }
        if (rows.length < PAGE) break;
        await pause();
      }
      if (cursor) cursors[table] = cursor;
    }
    return { sessions: places, skipped, cursors, ...(supported ? {} : { unsupported: true }) };
  } finally {
    db.close();
  }
}
