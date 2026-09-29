import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { decodeKeys, encodeKeys, keyHash, KeyList, KeySet } from "./outside-keys.js";
import { scanMarkedLines } from "./outside-logs.js";

/** One billed response, or tokens without a response of their own (a tool result). */
export interface PiUsageRecord {
  /** Entry id and time. A fork copies both, so a copied response is recognised. */
  key: string;
  /** Epoch ms; absent when the entry carried no readable time. */
  at?: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  requests: number;
}

/** A quarter hour's use of one model in one session. */
export interface PiBucket {
  /** Start of the quarter hour, epoch ms; -1 for entries without a readable time. */
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  requests: number;
}

/** Where the next read of a growing session file starts. */
export interface PiResume {
  offset: number;
  /** A hash of the first `headBytes` bytes, so a file written anew is read from its start. */
  head: number;
  headBytes: number;
  lastModel: string;
}

/** What one session file billed, as of the size and mtime it was read at, as sums per quarter hour. */
export interface PiSessionUsage {
  path: string;
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  /** The header's time, so the original of a fork is counted before its copies. */
  createdAt: number;
  buckets: PiBucket[];
  skippedLines: number;
  /** Responses a fork copied from a file read before it. */
  duplicates: number;
  /** Hashes of the responses this file counted. */
  keys: Float64Array;
  resume?: PiResume;
}

export interface PiScan {
  /** Whether the session directory exists at all. */
  found: boolean;
  sessions: PiSessionUsage[];
  /** Files that could not be read this time. */
  failed: number;
}

const CACHE_VERSION = 2;
/** One file at a time: parsing is this thread's work anyway, and an original is then always read before its fork. */
const READ_CONCURRENCY = 1;
const BUCKET_MS = 15 * 60 * 1000;
const HEAD_BYTES = 1024;
const MARKERS = ["\"usage\"", "\"type\":\"session\""];

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function timeOf(entry: Record<string, unknown>, message?: Record<string, unknown>): number | undefined {
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function modelName(message: Record<string, unknown>): string | undefined {
  const provider = typeof message.provider === "string" ? message.provider : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  if (provider && model) return `${provider}/${model}`;
  return model ?? provider;
}

function record(entry: Record<string, unknown>, usage: Record<string, unknown>, model: string, requests: number, message?: Record<string, unknown>): PiUsageRecord {
  const at = timeOf(entry, message);
  const id = typeof entry.id === "string" ? entry.id : "";
  return {
    key: `${id}@${at ?? ""}`,
    ...(at === undefined ? {} : { at }),
    model,
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    total: number(usage.totalTokens),
    cost: number(object(usage.cost)?.total),
    requests,
  };
}

async function headOf(path: string, bytes: number): Promise<number | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return bytesRead === bytes ? keyHash(buffer.toString("latin1")) : undefined;
  } finally {
    await handle.close();
  }
}

function releaseKeys(claims: KeySet, keys: Float64Array): void {
  for (const key of keys) claims.delete(key);
}

/**
 * Reads what one Pi session file billed, the way Pi's own session stats count
 * it: assistant and tool-result messages carry usage, and so do the entries a
 * compaction or a branch summary leaves. Only lines that mention usage are
 * parsed; the bulk of a session is tool output. A file that only grew since
 * `previous` is read from where that read stopped. A response another file
 * counted first (the original of a fork) is a copy and counts there.
 */
export async function readPiSessionUsage(path: string, stamp: { size: number; mtimeMs: number }, options: { claims?: KeySet; previous?: PiSessionUsage } = {}): Promise<PiSessionUsage> {
  const claims = options.claims ?? new KeySet();
  const previous = options.previous;
  const resume = previous?.resume;
  const grown = resume !== undefined && stamp.size > previous!.size && stamp.size >= resume.offset
    && (resume.headBytes === 0 || await headOf(path, resume.headBytes) === resume.head);
  if (previous && !grown) releaseKeys(claims, previous.keys);
  const from = grown ? previous : undefined;
  const buckets = new Map<string, PiBucket>();
  for (const bucket of from?.buckets ?? []) buckets.set(`${bucket.at}\u0000${bucket.model}`, { ...bucket });
  const keys = new KeyList(from?.keys);
  let duplicates = from?.duplicates ?? 0;
  let skippedLines = from?.skippedLines ?? 0;
  let header: Record<string, unknown> | undefined;
  let lastModel = from?.resume?.lastModel ?? "unknown model";
  const add = (item: PiUsageRecord) => {
    const key = keyHash(item.key);
    if (!claims.add(key)) { duplicates += 1; return; }
    keys.push(key);
    const at = item.at === undefined ? -1 : item.at - (item.at % BUCKET_MS);
    const id = `${at}\u0000${item.model}`;
    let bucket = buckets.get(id);
    if (!bucket) buckets.set(id, bucket = { at, model: item.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 });
    bucket.input += item.input;
    bucket.output += item.output;
    bucket.cacheRead += item.cacheRead;
    bucket.cacheWrite += item.cacheWrite;
    bucket.total += item.total;
    bucket.cost += item.cost;
    bucket.requests += item.requests;
  };
  let read;
  try {
    read = await scanMarkedLines(path, MARKERS, (line) => {
      let entry: Record<string, unknown> | undefined;
      try { entry = object(JSON.parse(line)); } catch { skippedLines += 1; return; }
      if (!entry) return;
      if (entry.type === "session") { header ??= entry; return; }
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        const usage = object(entry.usage);
        if (usage) add(record(entry, usage, lastModel, 1));
        return;
      }
      if (entry.type !== "message") return;
      const message = object(entry.message);
      const usage = object(message?.usage);
      if (!message || !usage) return;
      if (message.role === "assistant") {
        lastModel = modelName(message) ?? lastModel;
        add(record(entry, usage, lastModel, 1, message));
      } else if (message.role === "toolResult") {
        add(record(entry, usage, lastModel, 0, message));
      }
    }, (head) => head.includes("\"role\":\"assistant\"") || head.includes("\"role\":\"toolResult\""), { start: grown ? resume!.offset : 0 });
  } catch (error) {
    // Nothing of a failed read stays claimed; what the file counted before is claimed again.
    releaseKeys(claims, keys.values().subarray(from?.keys.length ?? 0));
    if (previous && !grown) for (const key of previous.keys) claims.add(key);
    throw error;
  }
  skippedLines += read.skipped;
  const created = typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  const headBytes = Math.min(HEAD_BYTES, read.end);
  const head = headBytes > 0 ? await headOf(path, headBytes) : 0;
  return {
    path,
    ...stamp,
    sessionId: from?.sessionId ?? (typeof header?.id === "string" ? header.id : basename(path, ".jsonl")),
    cwd: from?.cwd ?? (typeof header?.cwd === "string" ? header.cwd : ""),
    createdAt: from?.createdAt ?? (Number.isFinite(created) ? created : stamp.mtimeMs),
    buckets: [...buckets.values()].sort((left, right) => left.at - right.at),
    skippedLines,
    duplicates,
    keys: keys.values().slice(),
    resume: { offset: read.end, head: head ?? 0, headBytes: head === undefined ? 0 : headBytes, lastModel },
  };
}

/**
 * Session files in Pi's layout: `<dir>/<encoded cwd>/*.jsonl`, plus any file
 * directly in `<dir>`. `undefined` when the directory does not exist.
 */
export async function listPiSessionFiles(directory: string): Promise<string[] | undefined> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    if (!entry.isDirectory()) continue;
    const inner = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const file of inner) if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(path, file.name));
  }
  return files.sort();
}

type StoredBucket = [at: number, model: number, input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number, requests: number];

interface StoredSession extends Omit<PiSessionUsage, "buckets" | "keys"> {
  models: string[];
  buckets: StoredBucket[];
  keys: string;
}

export function encodeSession(session: PiSessionUsage): StoredSession {
  const models: string[] = [];
  const index = (model: string) => {
    const found = models.indexOf(model);
    if (found >= 0) return found;
    models.push(model);
    return models.length - 1;
  };
  const { buckets, keys, ...rest } = session;
  return {
    ...rest,
    models,
    buckets: buckets.map((item) => [item.at, index(item.model), item.input, item.output, item.cacheRead, item.cacheWrite, item.total, item.cost, item.requests]),
    keys: encodeKeys(keys),
  };
}

export function decodeSession(value: unknown): PiSessionUsage | undefined {
  const stored = object(value);
  if (!stored || typeof stored.path !== "string" || typeof stored.sessionId !== "string" || typeof stored.cwd !== "string") return undefined;
  if (!Array.isArray(stored.models) || !Array.isArray(stored.buckets)) return undefined;
  const keys = decodeKeys(stored.keys);
  if (!keys) return undefined;
  const models = stored.models.map((model) => typeof model === "string" ? model : "unknown model");
  const buckets: PiBucket[] = [];
  for (const item of stored.buckets) {
    if (!Array.isArray(item) || item.length !== 9) return undefined;
    buckets.push({
      at: number(item[0]), model: models[number(item[1])] ?? "unknown model",
      input: number(item[2]), output: number(item[3]), cacheRead: number(item[4]), cacheWrite: number(item[5]), total: number(item[6]), cost: number(item[7]), requests: number(item[8]),
    });
  }
  const resume = object(stored.resume);
  return {
    path: stored.path,
    size: number(stored.size),
    mtimeMs: number(stored.mtimeMs),
    sessionId: stored.sessionId,
    cwd: stored.cwd,
    createdAt: number(stored.createdAt),
    buckets,
    skippedLines: number(stored.skippedLines),
    duplicates: number(stored.duplicates),
    keys,
    ...(resume && typeof resume.offset === "number" && typeof resume.lastModel === "string"
      ? { resume: { offset: resume.offset, head: number(resume.head), headBytes: number(resume.headBytes), lastModel: resume.lastModel } }
      : {}),
  };
}

/**
 * What every session file billed, kept by path with the size and mtime it was
 * read at, as sums per quarter hour. A scan lists and stats the files and
 * reads only what changed, a grown file from where the last read stopped; the
 * rest come from memory, or from the cache file after a restart. Nothing
 * holds a whole file or every response.
 */
export class PiUsageCache {
  private readonly sessions = new Map<string, PiSessionUsage>();
  private readonly claims = new KeySet();
  /** Files that skipped copies of a file that is gone: read again, they count what is theirs now. */
  private readonly orphaned = new Set<string>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly file?: string) {}

  async scan(directory: string): Promise<PiScan> {
    await this.load();
    const files = await listPiSessionFiles(directory);
    if (!files) {
      this.forgetAllBut(new Set());
      await this.save();
      return { found: false, sessions: [], failed: 0 };
    }
    this.forgetAllBut(new Set(files));
    let failed = 0;
    // Oldest first by name (Pi's names start with their time): an original is read before its forks.
    const queue = [...files].sort((left, right) => basename(left).localeCompare(basename(right)));
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const info = await stat(path).catch(() => undefined);
        if (!info) { failed += 1; this.forget(path); continue; }
        const cached = this.sessions.get(path);
        const orphaned = this.orphaned.delete(path);
        if (!orphaned && cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) continue;
        // Dated by the stamp taken before the read: a file that grew meanwhile is read again next time.
        const previous = cached && orphaned ? { ...cached, resume: undefined } as PiSessionUsage : cached;
        const read = await readPiSessionUsage(path, { size: info.size, mtimeMs: info.mtimeMs }, { claims: this.claims, ...(previous ? { previous } : {}) }).catch(() => undefined);
        if (!read) { failed += 1; this.forget(path); continue; }
        this.sessions.set(path, read);
        this.dirty = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
    await this.save();
    return { found: true, sessions: files.flatMap((path) => this.sessions.get(path) ?? []), failed };
  }

  private forget(path: string): void {
    const session = this.sessions.get(path);
    if (!session) return;
    this.sessions.delete(path);
    this.dirty = true;
    releaseKeys(this.claims, session.keys);
    if (session.keys.length === 0) return;
    for (const other of this.sessions.values()) if (other.duplicates > 0) this.orphaned.add(other.path);
  }

  private forgetAllBut(keep: Set<string>): void {
    for (const path of [...this.sessions.keys()]) if (!keep.has(path)) this.forget(path);
  }

  private async load(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const lines = createInterface({ input: createReadStream(this.file, { encoding: "utf8" }), crlfDelay: Infinity });
      let first = true;
      for await (const line of lines) {
        if (first) {
          first = false;
          if (object(JSON.parse(line))?.version !== CACHE_VERSION) { lines.close(); return; }
          continue;
        }
        const session = decodeSession(JSON.parse(line));
        if (!session) continue;
        this.sessions.set(session.path, session);
        for (const key of session.keys) this.claims.add(key);
      }
    } catch {
      // A missing or unreadable cache only costs one full read.
      for (const session of this.sessions.values()) releaseKeys(this.claims, session.keys);
      this.sessions.clear();
    }
  }

  /** One line per session file, written as a stream: the cache is never one string in memory. */
  private async save(): Promise<void> {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const out = createWriteStream(temporary, { encoding: "utf8" });
      const closed = once(out, "close");
      const write = async (text: string) => { if (!out.write(text)) await once(out, "drain"); };
      await write(`${JSON.stringify({ version: CACHE_VERSION })}\n`);
      for (const session of [...this.sessions.values()]) await write(`${JSON.stringify(encodeSession(session))}\n`);
      out.end();
      await closed;
      await rename(temporary, this.file);
    } catch {
      this.dirty = true;
    }
  }
}
