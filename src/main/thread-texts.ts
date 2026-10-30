import { createHash } from "node:crypto";

/**
 * The visible text of a runtime's threads, for a search that indexes threads
 * nobody has open. A runtime backend keeps its transcripts in its own store;
 * `threadTextsDelta` answers from that store with only what the caller does
 * not hold yet, so an index stays current one small answer at a time
 * (API 1.12.0).
 */

/** The host command a runtime backend's kit registers for it, granted to the kits that index. */
export const THREAD_TEXTS_COMMAND = "thread-texts";

export interface ThreadTextsRequest {
  /** What the caller holds: thread id → the `updatedAt` it read it at. */
  known?: Record<string, number>;
  /** Threads per answer, newest first; the rest come with the next call. */
  limit?: number;
  /** API 1.79.0: opt into versioned catalogs and complete, bounded text pages. */
  protocol?: 2;
  knownVersions?: Record<string, string>;
  page?: ThreadTextPageRequest;
  /** UTF-16 units per text page, clamped to 2..64,000. */
  maxChars?: number;
}

export interface ThreadTextMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ThreadText {
  threadId: string;
  updatedAt: number;
  /** User and assistant text, oldest first, cut at `THREAD_TEXT_CHARS` in all. */
  messages: ThreadTextMessage[];
}

export interface ThreadTextsAnswer {
  /** Threads the caller does not hold, or holds older, newest first. */
  threads: ThreadText[];
  /** Ids the caller named that the store no longer has. */
  removed: string[];
  /** More changed threads are left beyond `limit`. */
  more: boolean;
  /** Absent on older machines: their text is a prefix, never a complete export. */
  protocol?: 2;
  catalog?: ThreadTextCatalogEntry[];
  page?: ThreadTextPage;
}

/** A durable opaque revision, independent of updatedAt and stable after restart. */
export interface ThreadTextCatalogEntry { threadId: string; updatedAt: number; version: string }
export interface ThreadTextPageRequest { threadId: string; version: string; cursor?: string }
export interface ThreadTextChunk {
  /** Storage ordinal, stable within one export version. */
  messageId: string;
  role: "user" | "assistant";
  /** UTF-16 offset in this message's visible text. */
  offset: number;
  text: string;
  /** Only this chunk closes the message. A page boundary never closes it. */
  end: boolean;
}
export interface ThreadTextPage {
  threadId: string;
  version: string;
  status: "ok" | "changed" | "missing" | "invalid-cursor";
  chunks: ThreadTextChunk[];
  /** null means the entire version has been read, including empty transcripts. */
  nextCursor: string | null;
}
export interface ThreadTextsPagedAnswer extends ThreadTextsAnswer {
  protocol: 2;
  catalog: ThreadTextCatalogEntry[];
}

/** Catalog deltas never read message payloads and are independent of the text budget. */
export function threadTextsCatalog(records: Iterable<ThreadTextCatalogEntry>, input: ThreadTextsRequest): ThreadTextsPagedAnswer {
  const limit = typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 25;
  const known = input.knownVersions && typeof input.knownVersions === "object" && !Array.isArray(input.knownVersions) ? input.knownVersions : {};
  const present = new Set<string>();
  const changed: ThreadTextCatalogEntry[] = [];
  for (const record of records) {
    present.add(record.threadId);
    if (known[record.threadId] !== record.version) changed.push(record);
  }
  changed.sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
  return { protocol: 2, threads: [], catalog: changed.slice(0, limit),
    removed: [...new Set([...Object.keys(known), ...Object.keys(input.known && typeof input.known === "object" ? input.known : {})])].filter(id => !present.has(id)), more: changed.length > limit };
}

/**
 * Self-contained so the SQLite worker can embed the same paging implementation.
 * The iterator starts at an ordinal, decodes at most one message at a time and
 * must yield every stored row, including invisible rows. No complete text array.
 */
export function threadTextPage(
  threadId: string, version: string, count: number,
  messages: (start: number) => Iterable<{ ordinal: number; role: string; text: string }>,
  input: ThreadTextsRequest,
): ThreadTextPage {
  const wanted = input.page!;
  const result: ThreadTextPage = { threadId, version, status: "ok", chunks: [], nextCursor: null };
  if (wanted.version !== version) return { ...result, status: "changed" };
  let start = 0, offset = 0;
  if (wanted.cursor !== undefined) {
    try {
      if (typeof wanted.cursor !== "string" || wanted.cursor.length > 4096) throw new Error("cursor");
      const cursor = JSON.parse(wanted.cursor) as unknown[];
      if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== threadId || cursor[1] !== version
        || !Number.isSafeInteger(cursor[2]) || Number(cursor[2]) < 0 || Number(cursor[2]) > count
        || !Number.isSafeInteger(cursor[3]) || Number(cursor[3]) < 0) throw new Error("cursor");
      start = Number(cursor[2]); offset = Number(cursor[3]);
      if (start === count && offset !== 0) throw new Error("cursor");
    } catch { return { ...result, status: "invalid-cursor" }; }
  }
  let left = typeof input.maxChars === "number" && Number.isSafeInteger(input.maxChars)
    ? Math.max(2, Math.min(64_000, input.maxChars)) : 64_000;
  let ordinal = start;
  // Bound object overhead as well as text. Chunks never split a surrogate pair.
  for (const message of messages(start)) {
    if (message.ordinal !== ordinal++ || ordinal > count) throw new Error("Incomplete thread text history");
    const at = message.ordinal === start ? offset : 0;
    if (at > message.text.length || at > 0 && at < message.text.length
      && /[\uD800-\uDBFF]/u.test(message.text[at - 1]!) && /[\uDC00-\uDFFF]/u.test(message.text[at]!)) {
      return { ...result, status: "invalid-cursor", chunks: [] };
    }
    if ((message.role !== "user" && message.role !== "assistant") || !message.text.trim()) {
      if (at) return { ...result, status: "invalid-cursor", chunks: [] };
      continue;
    }
    let position = at;
    do {
      let end = Math.min(message.text.length, position + Math.min(left, 16_384));
      if (end < message.text.length && /[\uD800-\uDBFF]/u.test(message.text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(message.text[end]!)) end--;
      if (end === position && position < message.text.length) {
        result.nextCursor = JSON.stringify([threadId, version, message.ordinal, position]);
        return result;
      }
      const text = message.text.slice(position, end);
      result.chunks.push({ messageId: String(message.ordinal), role: message.role, offset: position, text, end: end === message.text.length });
      left -= text.length; position = end;
      if (left < 2 || result.chunks.length >= 256) {
        const next = position === message.text.length ? message.ordinal + 1 : message.ordinal;
        result.nextCursor = next === count ? null : JSON.stringify([threadId, version, next, position === message.text.length ? 0 : position]);
        return result;
      }
    } while (position < message.text.length);
  }
  if (ordinal !== count) throw new Error("Incomplete thread text history");
  return result;
}

/** A thread's record as the backend stores keep it. */
export interface StoredThreadText {
  tauThreadId: string;
  updatedAt: number;
  messages: readonly { role: string; text: string }[];
}

/** Legacy clients keep this prefix budget; protocol 2 pages have no total-text cutoff. */
export const THREAD_TEXT_CHARS = 64_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function request(value: unknown): { known: Map<string, number>; limit: number } {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const known = new Map<string, number>();
  if (fields.known && typeof fields.known === "object" && !Array.isArray(fields.known)) {
    for (const [id, at] of Object.entries(fields.known)) if (typeof at === "number" && Number.isFinite(at)) known.set(id, at);
  }
  const limit = typeof fields.limit === "number" && Number.isSafeInteger(fields.limit) && fields.limit > 0 ? Math.min(fields.limit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { known, limit };
}

function textOf(messages: StoredThreadText["messages"]): ThreadTextMessage[] {
  const kept: ThreadTextMessage[] = [];
  let left = THREAD_TEXT_CHARS;
  for (const message of messages) {
    if ((message.role !== "user" && message.role !== "assistant") || !message.text.trim()) continue;
    const text = message.text.length > left ? message.text.slice(0, left) : message.text;
    kept.push({ role: message.role, text });
    left -= text.length;
    if (left <= 0) break;
  }
  return kept;
}

/** What `records` holds that the caller's `known` lacks; `input` is the command's unchecked input. */
export function threadTextsDelta(records: Iterable<StoredThreadText>, input: unknown): ThreadTextsAnswer {
  const fields = input && typeof input === "object" ? input as ThreadTextsRequest : {};
  if (fields.protocol === 2) {
    const catalog: ThreadTextCatalogEntry[] = [];
    let selected: StoredThreadText | undefined;
    for (const record of records) {
      // Hash each message separately rather than building one transcript string.
      const digest = createHash("sha256").update(JSON.stringify([record.tauThreadId, record.updatedAt]));
      for (const message of record.messages) digest.update(JSON.stringify([message.role, message.text]));
      catalog.push({ threadId: record.tauThreadId, updatedAt: record.updatedAt, version: digest.digest("hex") });
      if (record.tauThreadId === fields.page?.threadId) selected = record;
    }
    const answer = threadTextsCatalog(catalog, fields);
    if (fields.page) {
      const entry = catalog.find(item => item.threadId === fields.page!.threadId);
      answer.catalog = []; answer.removed = []; answer.more = false;
      answer.page = selected && entry ? threadTextPage(entry.threadId, entry.version, selected.messages.length,
        function* (start) { for (let ordinal = start; ordinal < selected!.messages.length; ordinal++) yield { ordinal, ...selected!.messages[ordinal]! }; }, fields)
        : { threadId: fields.page.threadId, version: fields.page.version, status: "missing", chunks: [], nextCursor: null };
    }
    return answer;
  }
  const { known, limit } = request(input);
  const present = new Set<string>();
  const changed: StoredThreadText[] = [];
  for (const record of records) {
    present.add(record.tauThreadId);
    const held = known.get(record.tauThreadId);
    if (held === undefined || held < record.updatedAt) changed.push(record);
  }
  changed.sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    threads: changed.slice(0, limit).map((record) => ({ threadId: record.tauThreadId, updatedAt: record.updatedAt, messages: textOf(record.messages) })),
    removed: [...known.keys()].filter((id) => !present.has(id)),
    more: changed.length > limit,
  };
}
