import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { openSqlite, readOpenCodeDatabase, type OpenCodeCursor } from "./opencode-store.js";
import { decodeKeys, encodeKeys, keyHash, KeyList, KeySet } from "./outside-keys.js";
import {
  CLAUDE_MARKERS,
  ClaudeProjectParser,
  claudeMayCarryUsage,
  CODEX_MARKERS,
  CodexRolloutParser,
  codexMayCarryUsage,
  RereadNeeded,
  scanMarkedLines,
  type ClaudeParserState,
  type CodexParserState,
  type OutsideIdentity,
  type OutsideRecord,
} from "./outside-logs.js";
import type { OutsideFormat, UsageBilling } from "./protocol.js";

/** A folder a runtime kit named, with what its login bills. */
export interface OutsideRoot {
  format: OutsideFormat;
  /** The runtime family its records count under: `codex`, `claude-code`, `opencode`. */
  backend: string;
  label: string;
  path: string;
  billing?: UsageBilling;
}

/** A quarter of an hour's responses of one model in one session. */
export interface OutsideBucket {
  /** Start of the quarter hour, epoch ms: a day of any time zone starts on one. */
  at: number;
  model: string;
  provider?: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface OutsideSessionUsage extends OutsideIdentity {
  buckets: OutsideBucket[];
}

/** Where the next read of a growing log starts, and the parser's state there. */
export interface OutsideResume {
  offset: number;
  /** A hash of the file's first bytes, so a file written anew is read from its start. */
  head: number;
  headBytes: number;
  parser: CodexParserState | ClaudeParserState;
  /** Set when counters had to give way to response records (see `RereadNeeded`). */
  modernSince?: number;
}

/** What one file (or one database) held, as of the stamp it was read at: sums, never single responses. */
export interface OutsideUnit {
  path: string;
  format: OutsideFormat;
  size: number;
  mtimeMs: number;
  sessions: OutsideSessionUsage[];
  skipped: number;
  /** Responses another log had counted first (a resumed or archived copy). */
  duplicates: number;
  /** Hashes of the responses this unit counted. */
  keys: Float64Array;
  resume?: OutsideResume;
  /** A database's rows that can no longer change, and how far they go. */
  final?: OutsideSessionUsage[];
  cursors?: Record<string, OpenCodeCursor>;
}

export interface OutsideRootReport {
  root: OutsideRoot;
  found: boolean;
  files: number;
  failed: number;
}

export interface OutsideScan {
  roots: OutsideRootReport[];
  units: Array<{ root: OutsideRoot; unit: OutsideUnit }>;
  /** A read is still under way; what it has not reached yet is missing. */
  reading: boolean;
  /** Records before this were never read. */
  horizon: number;
}

/** How far back the logs are read: a year, so a cold read of years of logs stays bounded. */
export const OUTSIDE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
/** Responses are summed per quarter hour: every time zone's midnight falls on one. */
export const OUTSIDE_BUCKET_MS = 15 * 60 * 1000;
const CACHE_VERSION = 2;
/** One file at a time: parsing is this thread's work anyway, and the first copy of a response is then always the same. */
const READ_CONCURRENCY = 1;
const MAX_DEPTH = 5;
/** A long first read saves what it has every so many files, so a restart resumes. */
const SAVE_EVERY = 500;
const OPENCODE_DATABASE = /^opencode(?:-[\w.-]+)?\.db$/u;
/** How much of a log's start must be unchanged for a read to go on where the last one stopped. */
const HEAD_BYTES = 1024;

async function walk(directory: string, accept: (name: string) => boolean, depth = 0, into: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return into; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    // Symbolic links are never followed: a link could lead anywhere.
    if (entry.isFile() && accept(entry.name)) into.push(path);
    else if (entry.isDirectory() && depth < MAX_DEPTH) await walk(path, accept, depth + 1, into);
  }
  return into;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isDirectory(), () => false);
}

/** The files a root holds; `undefined` when the folder is not there. */
export async function listOutsideFiles(root: OutsideRoot): Promise<string[] | undefined> {
  if (!await exists(root.path)) return undefined;
  if (root.format === "opencode") {
    const names = await readdir(root.path).catch(() => [] as string[]);
    return names.filter((name) => OPENCODE_DATABASE.test(name)).map((name) => join(root.path, name)).sort();
  }
  return (await walk(root.path, (name) => name.endsWith(".jsonl"))).sort();
}

/** Size and time of a file; a database's write-ahead log counts, it holds the newest rows. */
async function stampOf(path: string, format: OutsideFormat): Promise<{ size: number; mtimeMs: number } | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  if (format !== "opencode") return { size: info.size, mtimeMs: info.mtimeMs };
  const wal = await stat(`${path}-wal`).catch(() => undefined);
  return { size: info.size + (wal?.size ?? 0), mtimeMs: Math.max(info.mtimeMs, wal?.mtimeMs ?? 0) };
}

/** A hash of a file's first bytes. */
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

/**
 * Sums one unit's responses per session, model and quarter hour as they are
 * read, and claims each response's key: one another log counted first is a
 * copy and counts nowhere else.
 */
class UnitTally {
  private readonly sessions = new Map<string, Map<string, OutsideBucket>>();
  readonly keys: KeyList;
  duplicates = 0;

  /** Without `claims` nothing is compared with other logs (a database recognises its own copies). */
  constructor(private readonly claims: KeySet | undefined, private readonly horizon: number, from?: Pick<OutsideUnit, "keys" | "duplicates" | "sessions">) {
    this.keys = new KeyList(from?.keys);
    this.duplicates = from?.duplicates ?? 0;
    for (const session of from?.sessions ?? []) {
      const buckets = this.bucketsOf(session.sessionId);
      for (const bucket of session.buckets) buckets.set(bucketKey(bucket.at, bucket.model, bucket.provider), { ...bucket });
    }
  }

  add(sessionId: string, record: OutsideRecord): boolean {
    if (record.at < this.horizon) return false;
    if (this.claims) {
      const key = keyHash(record.key);
      if (!this.claims.add(key)) { this.duplicates += 1; return false; }
      this.keys.push(key);
    }
    this.tally(sessionId, record, 1);
    return true;
  }

  replace(sessionId: string, previous: OutsideRecord, next: OutsideRecord): void {
    this.tally(sessionId, previous, -1);
    this.tally(sessionId, next, 1);
  }

  /** Adds a sum as it is, for a unit made of two tallies. */
  addBucket(sessionId: string, bucket: OutsideBucket): void {
    const buckets = this.bucketsOf(sessionId);
    const key = bucketKey(bucket.at, bucket.model, bucket.provider);
    const into = buckets.get(key);
    if (!into) { buckets.set(key, { ...bucket }); return; }
    into.requests += bucket.requests;
    into.input += bucket.input;
    into.output += bucket.output;
    into.cacheRead += bucket.cacheRead;
    into.cacheWrite += bucket.cacheWrite;
    into.total += bucket.total;
    into.cost += bucket.cost;
  }

  /** Gives back every key this tally claimed, for a read that starts over. */
  release(): void {
    if (this.claims) releaseKeys(this.claims, this.keys.values());
  }

  sessionsWith(identity: (sessionId: string) => OutsideIdentity): OutsideSessionUsage[] {
    return [...this.sessions].map(([sessionId, buckets]) => ({
      ...identity(sessionId),
      buckets: [...buckets.values()].filter((bucket) => bucket.requests > 0).sort((left, right) => left.at - right.at),
    }));
  }

  private bucketsOf(sessionId: string): Map<string, OutsideBucket> {
    let buckets = this.sessions.get(sessionId);
    if (!buckets) this.sessions.set(sessionId, buckets = new Map());
    return buckets;
  }

  private tally(sessionId: string, record: OutsideRecord, sign: 1 | -1): void {
    const at = record.at - (record.at % OUTSIDE_BUCKET_MS);
    const buckets = this.bucketsOf(sessionId);
    const key = bucketKey(at, record.model, record.provider);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { at, model: record.model, ...(record.provider ? { provider: record.provider } : {}), requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
      buckets.set(key, bucket);
    }
    bucket.requests += sign;
    bucket.input += sign * record.input;
    bucket.output += sign * record.output;
    bucket.cacheRead += sign * record.cacheRead;
    bucket.cacheWrite += sign * record.cacheWrite;
    bucket.total += sign * record.total;
    bucket.cost += sign * record.cost;
  }
}

function bucketKey(at: number, model: string, provider: string | undefined): string {
  return `${at}\u0000${model}\u0000${provider ?? ""}`;
}

type Stamp = { size: number; mtimeMs: number };

/** One log file, from where `previous` stopped when the file only grew, else from its start. */
async function readLogUnit(path: string, format: "codex" | "agent-sdk", stamp: Stamp, claims: KeySet, horizon: number, previous: OutsideUnit | undefined): Promise<OutsideUnit> {
  const resume = previous?.resume;
  const grown = resume && previous.format === format && stamp.size > previous.size && stamp.size >= resume.offset
    && (resume.headBytes === 0 || await headOf(path, resume.headBytes) === resume.head);
  if (grown) {
    try {
      return await readLogFrom(path, format, stamp, claims, horizon, previous, resume);
    } catch (error) {
      if (!(error instanceof RereadNeeded)) throw error;
      // The file is counted anew, from its start.
    }
  }
  // A read from the start gives back what the file counted before, and claims it again should the read fail.
  if (previous) releaseKeys(claims, previous.keys);
  try {
    try {
      return await readLogFrom(path, format, stamp, claims, horizon, undefined, undefined, previous?.resume?.modernSince);
    } catch (error) {
      if (!(error instanceof RereadNeeded)) throw error;
      return await readLogFrom(path, format, stamp, claims, horizon, undefined, undefined, error.modernSince);
    }
  } catch (error) {
    if (previous) for (const key of previous.keys) claims.add(key);
    throw error;
  }
}

async function readLogFrom(path: string, format: "codex" | "agent-sdk", stamp: Stamp, claims: KeySet, horizon: number, previous: OutsideUnit | undefined, resume: OutsideResume | undefined, modernSince?: number): Promise<OutsideUnit> {
  const tally = new UnitTally(claims, horizon, previous);
  const fallback = basename(path, ".jsonl");
  const sessionOf = () => "";
  const sink = {
    add: (record: OutsideRecord) => tally.add(sessionOf(), record),
    replace: (before: OutsideRecord, after: OutsideRecord) => tally.replace(sessionOf(), before, after),
  };
  const since = modernSince ?? resume?.modernSince;
  const parser = format === "codex"
    ? new CodexRolloutParser(fallback, sink, resume?.parser as CodexParserState | undefined, since)
    : new ClaudeProjectParser(fallback, sink, resume?.parser as ClaudeParserState | undefined);
  let read;
  try {
    read = await scanMarkedLines(path, format === "codex" ? CODEX_MARKERS : CLAUDE_MARKERS, (line) => parser.line(line), format === "codex" ? codexMayCarryUsage : claudeMayCarryUsage, { start: resume?.offset ?? 0 });
  } catch (error) {
    // Nothing a failed read claimed stays claimed; a resumed read's earlier keys stay with the unit it resumed.
    tally.release();
    if (previous) for (const key of previous.keys) claims.add(key);
    throw error;
  }
  const identity = parser.identity();
  const headBytes = Math.min(HEAD_BYTES, read.end);
  const head = headBytes > 0 ? await headOf(path, headBytes) : 0;
  return {
    path,
    format,
    ...stamp,
    // One session per log file, whoever the parser learnt it was.
    sessions: tally.sessionsWith(() => identity).filter((session) => session.buckets.length > 0),
    skipped: (previous?.skipped ?? 0) + parser.skipped + read.skipped,
    duplicates: tally.duplicates,
    keys: tally.keys.values().slice(),
    resume: { offset: read.end, head: head ?? 0, headBytes: head === undefined ? 0 : headBytes, parser: parser.snapshot(), ...(since === undefined ? {} : { modernSince: since }) },
  };
}

function releaseKeys(claims: KeySet, keys: Float64Array): void {
  for (const key of keys) claims.delete(key);
}

/** How long an OpenCode row may still change after it was created (a response streams its tokens in). */
const OPENCODE_SETTLE_MS = 24 * 60 * 60 * 1000;

/**
 * An OpenCode database: its final rows are summed once and kept; each read
 * goes on past them and sums the rows that came since or may still change.
 */
async function readDatabaseUnit(path: string, stamp: Stamp, horizon: number, now: number, previous: OutsideUnit | undefined): Promise<OutsideUnit> {
  const sqlite = await openSqlite();
  if (!sqlite) throw new Error("this runtime has no SQLite");
  const empty = { keys: new Float64Array(), duplicates: 0, sessions: [] };
  let final = new UnitTally(undefined, horizon, previous?.final ? { ...empty, sessions: previous.final } : empty);
  const recent = new UnitTally(undefined, horizon);
  const read = await readOpenCodeDatabase(path, {
    since: horizon,
    finalBefore: now - OPENCODE_SETTLE_MS,
    ...(previous?.final && previous.cursors ? { cursors: previous.cursors } : {}),
    onRestart: () => { final = new UnitTally(undefined, horizon); },
  }, sqlite, () => yieldToLoop(), (sessionId, record, settled) => { (settled ? final : recent).add(sessionId, record); });
  if (read.unsupported) throw new Error("the database has no message table this version reads");
  const places = read.sessions;
  const identity = (sessionId: string): OutsideIdentity => {
    const place = places.get(sessionId);
    return { sessionId, cwd: place?.cwd ?? "", ...(place?.parentId ? { parentId: place.parentId } : {}) };
  };
  const settled = final.sessionsWith(identity);
  // What the page sees: the final rows and the recent ones together.
  const all = new UnitTally(undefined, horizon, { ...empty, sessions: settled });
  for (const session of recent.sessionsWith(identity)) for (const bucket of session.buckets) all.addBucket(session.sessionId, bucket);
  return {
    path,
    format: "opencode",
    ...stamp,
    sessions: all.sessionsWith(identity),
    skipped: read.skipped,
    duplicates: 0,
    keys: new Float64Array(),
    final: settled,
    cursors: read.cursors,
  };
}

type StoredBucket = [at: number, model: number, provider: number, requests: number, input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number];

type StoredSession = OutsideIdentity & { buckets: StoredBucket[] };

interface StoredUnit extends Omit<OutsideUnit, "sessions" | "keys" | "final"> {
  models: string[];
  sessions: StoredSession[];
  final?: StoredSession[];
  keys: string;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function encodeUnit(unit: OutsideUnit): StoredUnit {
  const models: string[] = [];
  const index = (value: string | undefined) => {
    if (value === undefined) return -1;
    const found = models.indexOf(value);
    if (found >= 0) return found;
    models.push(value);
    return models.length - 1;
  };
  const store = (sessions: OutsideSessionUsage[]): StoredSession[] => sessions.map((session) => ({
    ...session,
    buckets: session.buckets.map((bucket): StoredBucket => [bucket.at, index(bucket.model), index(bucket.provider), bucket.requests, bucket.input, bucket.output, bucket.cacheRead, bucket.cacheWrite, bucket.total, bucket.cost]),
  }));
  const { final, ...rest } = unit;
  return { ...rest, models, sessions: store(unit.sessions), ...(final ? { final: store(final) } : {}), keys: encodeKeys(unit.keys) };
}

export function decodeUnit(value: unknown): OutsideUnit | undefined {
  const stored = value && typeof value === "object" ? value as Partial<StoredUnit> : undefined;
  if (!stored || typeof stored.path !== "string" || !["codex", "agent-sdk", "opencode"].includes(stored.format as string)) return undefined;
  if (!Array.isArray(stored.models) || !Array.isArray(stored.sessions)) return undefined;
  const keys = decodeKeys(stored.keys);
  if (!keys) return undefined;
  const models = stored.models.map((model) => typeof model === "string" ? model : "unknown model");
  const sessions = decodeSessions(stored.sessions, models);
  const final = stored.final === undefined ? undefined : decodeSessions(stored.final, models);
  if (!sessions || (stored.final !== undefined && !final)) return undefined;
  const resume = stored.resume && typeof stored.resume === "object" && typeof stored.resume.offset === "number" ? stored.resume : undefined;
  const cursors = stored.cursors && typeof stored.cursors === "object" ? stored.cursors : undefined;
  return {
    path: stored.path, format: stored.format as OutsideFormat, size: number(stored.size), mtimeMs: number(stored.mtimeMs), sessions,
    skipped: number(stored.skipped), duplicates: number(stored.duplicates), keys, ...(resume ? { resume } : {}),
    ...(final && cursors ? { final, cursors } : {}),
  };
}

function decodeSessions(value: unknown, models: string[]): OutsideSessionUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sessions: OutsideSessionUsage[] = [];
  for (const session of value as Array<Partial<StoredSession> | null>) {
    if (!session || typeof session.sessionId !== "string" || typeof session.cwd !== "string" || !Array.isArray(session.buckets)) return undefined;
    const buckets: OutsideBucket[] = [];
    for (const item of session.buckets) {
      if (!Array.isArray(item) || item.length !== 10) return undefined;
      const provider = models[number(item[2])];
      buckets.push({
        at: number(item[0]), model: models[number(item[1])] ?? "unknown model",
        ...(item[2] >= 0 && provider ? { provider } : {}),
        requests: number(item[3]), input: number(item[4]), output: number(item[5]), cacheRead: number(item[6]), cacheWrite: number(item[7]), total: number(item[8]), cost: number(item[9]),
      });
    }
    sessions.push({ sessionId: session.sessionId, cwd: session.cwd, ...(typeof session.parentId === "string" ? { parentId: session.parentId } : {}), buckets });
  }
  return sessions;
}

type Listed = { root: OutsideRoot; files: string[] | undefined; failed: Set<string> };

/**
 * What the agent CLIs' own logs hold, kept by path with the size and mtime
 * each file was read at, as sums per quarter hour. A refresh lists the
 * roots, reads only what changed (a log that grew from where the last read
 * stopped) and saves counts and key hashes, never text. Nothing holds a
 * whole file or every response, so years of logs fit a worker's heap. A
 * snapshot answers at once with what is read so far, so a first read of a
 * large history runs in the background of the summaries that ask for it.
 */
export class OutsideUsageCache {
  private readonly units = new Map<string, OutsideUnit>();
  private readonly claims = new KeySet();
  /** Units that skipped copies of a log that is gone: read again, they count what is theirs now. */
  private readonly orphaned = new Set<string>();
  private listed = new Map<string, Listed>();
  private loading: Promise<void> | undefined;
  private dirty = false;
  private running: Promise<void> | undefined;
  private finished = false;

  constructor(private readonly file: string | undefined, private readonly now: () => number) {}

  get reading(): boolean {
    return this.running !== undefined;
  }

  /** Whether a read has finished once, in this run or one the cache file keeps. */
  async readBefore(): Promise<boolean> {
    await this.load();
    return this.finished;
  }

  /** Reads what changed under `roots`; a refresh already running is joined, not doubled. */
  refresh(roots: readonly OutsideRoot[]): Promise<void> {
    this.running ??= this.read(roots).finally(() => { this.running = undefined; });
    return this.running;
  }

  snapshot(): OutsideScan {
    const roots: OutsideRootReport[] = [];
    const units: OutsideScan["units"] = [];
    for (const { root, files, failed } of this.listed.values()) {
      let read = 0;
      for (const path of files ?? []) {
        const unit = this.units.get(path);
        if (!unit || unit.format !== root.format) continue;
        units.push({ root, unit });
        read += 1;
      }
      roots.push({ root, found: files !== undefined, files: read, failed: failed.size });
    }
    return { roots, units, reading: this.reading, horizon: this.now() - OUTSIDE_HORIZON_MS };
  }

  private async read(roots: readonly OutsideRoot[]): Promise<void> {
    await this.load();
    const horizon = this.now() - OUTSIDE_HORIZON_MS;
    const listed = new Map<string, Listed>();
    const seen = new Set<string>();
    for (const root of roots) {
      const key = `${root.format}\u0000${root.path}`;
      if (listed.has(key)) continue;
      // Another instance naming the same folder reads no file twice.
      const files = (await listOutsideFiles(root))?.filter((path) => !seen.has(path));
      for (const path of files ?? []) seen.add(path);
      listed.set(key, { root, files, failed: new Set() });
    }
    this.listed = listed;
    for (const path of [...this.units.keys()]) if (!seen.has(path)) this.drop(path);
    const queue = [...listed.values()].flatMap((entry) => (entry.files ?? []).map((path) => ({ entry, path })));
    let sinceSave = 0;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { entry, path } = job;
        const format = entry.root.format;
        const stamp = await stampOf(path, format);
        if (!stamp || stamp.mtimeMs < horizon) { this.drop(path); continue; }
        const cached = this.units.get(path);
        const orphaned = this.orphaned.delete(path);
        if (!orphaned && cached && cached.format === format && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) continue;
        // Dated by the stamp taken before the read: a file that grew meanwhile is read again next time.
        const previous = cached?.format === format ? cached : undefined;
        if (cached && !previous) this.drop(path);
        const unit = await (format === "opencode"
          ? readDatabaseUnit(path, stamp, horizon, this.now(), previous)
          : readLogUnit(path, format, stamp, this.claims, horizon, orphaned ? { ...previous!, resume: undefined } as OutsideUnit : previous)
        ).catch(() => undefined);
        if (!unit) { entry.failed.add(path); continue; }
        this.units.set(path, unit);
        this.dirty = true;
        if (++sinceSave >= SAVE_EVERY) { sinceSave = 0; await this.save(); }
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    await this.save();
    this.finished = true;
  }

  /** Forgets a unit; logs that skipped its copies read again next time. */
  private drop(path: string): void {
    const unit = this.units.get(path);
    if (!unit) return;
    this.units.delete(path);
    this.dirty = true;
    releaseKeys(this.claims, unit.keys);
    if (unit.keys.length === 0) return;
    for (const other of this.units.values()) if (other.duplicates > 0) this.orphaned.add(other.path);
  }

  private load(): Promise<void> {
    this.loading ??= this.readFile();
    return this.loading;
  }

  private async readFile(): Promise<void> {
    if (!this.file) return;
    try {
      const lines = createInterface({ input: createReadStream(this.file, { encoding: "utf8" }), crlfDelay: Infinity });
      let first = true;
      for await (const line of lines) {
        if (first) {
          first = false;
          const header = JSON.parse(line) as { version?: unknown };
          if (header?.version !== CACHE_VERSION) { lines.close(); return; }
          continue;
        }
        const unit = decodeUnit(JSON.parse(line));
        if (!unit) continue;
        this.units.set(unit.path, unit);
        for (const key of unit.keys) this.claims.add(key);
      }
      this.finished = this.units.size > 0;
    } catch {
      // A missing or unreadable cache only costs one full read.
      for (const unit of this.units.values()) releaseKeys(this.claims, unit.keys);
      this.units.clear();
    }
  }

  /** One line per unit, written as a stream: the file is never one string in memory. */
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
      for (const unit of [...this.units.values()]) await write(`${JSON.stringify(encodeUnit(unit))}\n`);
      out.end();
      await closed;
      await rename(temporary, this.file);
    } catch {
      this.dirty = true;
    }
  }
}
