import { open, stat } from "node:fs/promises";
import { SessionTextCollector, THREAD_TEXT_LIMIT, type ThreadText } from "./threads.js";

/** JSONL is read in chunks; neither a tool dump nor one giant line can grow memory without a bound. */
export const SESSION_READ_BYTES = 8_000_000;
export const SESSION_LINE_BYTES = 4_000_000;
export const SESSION_CACHE_CHARS = 4_000_000;
export const SESSION_METADATA_MS = 5_000;
export const SESSION_STAT_CONCURRENCY = 8;
const CHUNK_BYTES = 64 * 1024;

interface Session { sessionId: string; path: string }
export interface DatedSession extends Session { mtimeMs: number; size: number }
export interface SessionTexts { texts: ThreadText[]; truncated: boolean; error?: string; bytesRead: number }

/** Keeps the first messages, skipping lines too large to parse and reporting every omitted range. */
export async function readSessionTexts(path: string, size: number, cancelled: () => boolean = () => false, maxReadBytes = SESSION_READ_BYTES): Promise<SessionTexts> {
  maxReadBytes = Math.min(maxReadBytes, SESSION_READ_BYTES);
  const collector = new SessionTextCollector();
  const file = await open(path, "r");
  let bytesRead = 0;
  let lineBytes = 0;
  let parts: Buffer[] = [];
  let skipping = false;
  const line = () => {
    if (!skipping) collector.line(Buffer.concat(parts, lineBytes).toString("utf8"));
    parts = []; lineBytes = 0; skipping = false;
  };
  try {
    while (!cancelled() && bytesRead < maxReadBytes && collector.chars < THREAD_TEXT_LIMIT) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxReadBytes - bytesRead));
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
      let start = 0;
      for (let at = 0; at < read.bytesRead; at += 1) {
        if (chunk[at] !== 10) continue;
        append(chunk.subarray(start, at));
        line();
        start = at + 1;
        if (collector.chars >= THREAD_TEXT_LIMIT) {
          collector.truncated ||= at + 1 < read.bytesRead || bytesRead < size;
          break;
        }
      }
      if (collector.chars >= THREAD_TEXT_LIMIT) break;
      append(chunk.subarray(start, read.bytesRead));
    }
    // A byte-limited fragment is not a complete JSON record, even if it happens to parse.
    if (bytesRead >= size && !cancelled() && collector.chars < THREAD_TEXT_LIMIT) line();
    else if (bytesRead < size || cancelled()) collector.truncated = true;
    return { texts: collector.texts, truncated: collector.truncated, bytesRead };
  } finally { await file.close(); }

  function append(part: Buffer): void {
    if (skipping) return;
    if (lineBytes + part.length > SESSION_LINE_BYTES) {
      collector.truncated = true; skipping = true; parts = []; lineBytes = 0;
    } else { parts.push(part); lineBytes += part.length; }
  }
}

/** One metadata refresh and one file read at a time, shared by every palette query. */
export class SessionTextIndex {
  private metadata?: { at: number; entries: DatedSession[]; incomplete: boolean };
  private refreshing?: Promise<{ entries: DatedSession[]; incomplete: boolean }>;
  private generation = 0;
  private readonly cache = new Map<string, { version: string; result: SessionTexts; chars: number }>();
  private reading: Promise<unknown> = Promise.resolve();
  private chars = 0;

  constructor(private readonly options: { list(): Promise<Session[]>; now(): number; budgetChars?: number }) {}

  get size(): number { return this.chars; }

  invalidate(): void {
    this.generation += 1;
    this.metadata = undefined;
    this.cache.clear();
    this.chars = 0;
  }

  async sessions(): Promise<{ entries: DatedSession[]; incomplete: boolean }> {
    if (this.metadata && this.options.now() - this.metadata.at < SESSION_METADATA_MS) return this.metadata;
    if (this.refreshing) {
      await this.refreshing;
      return this.sessions();
    }
    const generation = this.generation;
    const refresh = (async () => {
      const sessions = await this.options.list();
      const entries: DatedSession[] = [];
      let next = 0;
      let incomplete = false;
      await Promise.all(Array.from({ length: Math.min(SESSION_STAT_CONCURRENCY, sessions.length) }, async () => {
        while (next < sessions.length) {
          const session = sessions[next++]!;
          try {
            const info = await stat(session.path);
            entries.push({ ...session, mtimeMs: info.mtimeMs, size: info.size });
          } catch { incomplete = true; }
        }
      }));
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      if (this.generation === generation) {
        const listed = new Set(entries.map((entry) => entry.path));
        for (const path of this.cache.keys()) if (!listed.has(path)) this.drop(path);
        this.metadata = { at: this.options.now(), entries, incomplete };
      }
      return { entries, incomplete };
    })();
    this.refreshing = refresh;
    try { await refresh; }
    finally { if (this.refreshing === refresh) this.refreshing = undefined; }
    return this.generation === generation ? refresh : this.sessions();
  }

  texts(session: DatedSession, cancelled: () => boolean = () => false, maxReadBytes = SESSION_READ_BYTES): Promise<SessionTexts> {
    const generation = this.generation;
    const read = this.reading.then(async () => {
      if (cancelled()) return { texts: [], truncated: true, bytesRead: 0 };
      const version = `${session.mtimeMs}:${session.size}`;
      const cached = this.cache.get(session.path);
      if (cached?.version === version) {
        this.cache.delete(session.path); this.cache.set(session.path, cached);
        return { ...cached.result, bytesRead: 0 };
      }
      let result: SessionTexts;
      try { result = await readSessionTexts(session.path, session.size, cancelled, maxReadBytes); }
      catch { return { texts: [], truncated: true, bytesRead: 0, error: "Some thread files could not be read." }; }
      if (!cancelled() && this.generation === generation && maxReadBytes >= SESSION_READ_BYTES) {
        this.drop(session.path);
        const chars = result.texts.reduce((total, text) => total + text.text.length, 0);
        const budget = this.options.budgetChars ?? SESSION_CACHE_CHARS;
        // An entry larger than the entire cache can be searched without retaining it.
        if (chars <= budget) {
          while (this.chars + chars > budget || this.cache.size >= 400) this.drop(this.cache.keys().next().value!);
          this.cache.set(session.path, { version, result, chars });
          this.chars += chars;
        }
      }
      return result;
    });
    this.reading = read.catch(() => undefined);
    return read;
  }

  private drop(path: string): void {
    const entry = this.cache.get(path);
    if (entry) this.chars -= entry.chars;
    this.cache.delete(path);
  }
}
