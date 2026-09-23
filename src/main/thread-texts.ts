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
}

/** A thread's record as the backend stores keep it. */
export interface StoredThreadText {
  tauThreadId: string;
  updatedAt: number;
  messages: readonly { role: string; text: string }[];
}

/** One thread carries at most this much text; the start of a long thread is kept. */
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
