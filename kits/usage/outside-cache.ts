import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { openSqlite, readOpenCodeDatabase } from "./opencode-store.js";
import {
  CLAUDE_MARKERS,
  ClaudeProjectParser,
  claudeMayCarryUsage,
  CODEX_MARKERS,
  CodexRolloutParser,
  codexMayCarryUsage,
  readMarkedLines,
  type OutsideRecord,
  type OutsideSession,
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

/** What one file (or one database) held, as of the stamp it was read at. */
export interface OutsideUnit {
  path: string;
  format: OutsideFormat;
  size: number;
  mtimeMs: number;
  sessions: OutsideSession[];
  skipped: number;
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
const CACHE_VERSION = 1;
const READ_CONCURRENCY = 2;
const MAX_DEPTH = 5;
/** A long first read saves what it has every so many files, so a restart resumes. */
const SAVE_EVERY = 200;
const OPENCODE_DATABASE = /^opencode(?:-[\w.-]+)?\.db$/u;

/** Only a digest of a record's ids is kept. */
function digest(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 16);
}

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

function hashed(session: OutsideSession, horizon: number): OutsideSession {
  return { ...session, records: session.records.filter((record) => record.at >= horizon).map((record) => ({ ...record, key: digest(record.key) })) };
}

/** Reads one file (or database) of a root. */
export async function readOutsideUnit(path: string, format: OutsideFormat, stamp: { size: number; mtimeMs: number }, horizon: number): Promise<OutsideUnit> {
  if (format === "opencode") {
    const open = await openSqlite();
    if (!open) throw new Error("this runtime has no SQLite");
    const read = await readOpenCodeDatabase(path, horizon, open, () => yieldToLoop());
    if (read.unsupported) throw new Error("the database has no message table this version reads");
    return { path, format, ...stamp, sessions: read.sessions.map((session) => hashed(session, horizon)), skipped: read.skipped };
  }
  const fallback = basename(path, ".jsonl");
  const parser = format === "codex" ? new CodexRolloutParser(fallback) : new ClaudeProjectParser(fallback);
  const oversized = await readMarkedLines(path, format === "codex" ? CODEX_MARKERS : CLAUDE_MARKERS, (line) => parser.line(line), format === "codex" ? codexMayCarryUsage : claudeMayCarryUsage);
  const session = hashed(parser.finish(), horizon);
  return { path, format, ...stamp, sessions: session.records.length > 0 ? [session] : [], skipped: parser.skipped + oversized };
}

type StoredRecord = [key: string, at: number, model: number, provider: number, input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number];

interface StoredUnit extends Omit<OutsideUnit, "sessions"> {
  models: string[];
  sessions: Array<Omit<OutsideSession, "records"> & { records: StoredRecord[] }>;
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
  return {
    ...unit,
    models,
    sessions: unit.sessions.map((session) => ({
      ...session,
      records: session.records.map((record): StoredRecord => [record.key, record.at, index(record.model), index(record.provider), record.input, record.output, record.cacheRead, record.cacheWrite, record.total, record.cost]),
    })),
  };
}

export function decodeUnit(value: unknown): OutsideUnit | undefined {
  const stored = value && typeof value === "object" ? value as Partial<StoredUnit> : undefined;
  if (!stored || typeof stored.path !== "string" || !["codex", "agent-sdk", "opencode"].includes(stored.format as string)) return undefined;
  if (!Array.isArray(stored.models) || !Array.isArray(stored.sessions)) return undefined;
  const models = stored.models.map((model) => typeof model === "string" ? model : "unknown model");
  const sessions: OutsideSession[] = [];
  for (const session of stored.sessions) {
    if (!session || typeof session.sessionId !== "string" || typeof session.cwd !== "string" || !Array.isArray(session.records)) return undefined;
    const records: OutsideRecord[] = [];
    for (const item of session.records) {
      if (!Array.isArray(item) || item.length !== 10 || typeof item[0] !== "string") return undefined;
      const provider = models[number(item[3])];
      records.push({
        key: item[0], at: number(item[1]), model: models[number(item[2])] ?? "unknown model",
        ...(item[3] >= 0 && provider ? { provider } : {}),
        input: number(item[4]), output: number(item[5]), cacheRead: number(item[6]), cacheWrite: number(item[7]), total: number(item[8]), cost: number(item[9]),
      });
    }
    sessions.push({ sessionId: session.sessionId, cwd: session.cwd, ...(typeof session.parentId === "string" ? { parentId: session.parentId } : {}), records });
  }
  return { path: stored.path, format: stored.format as OutsideFormat, size: number(stored.size), mtimeMs: number(stored.mtimeMs), sessions, skipped: number(stored.skipped) };
}

/**
 * What the agent CLIs' own logs hold, kept by path with the size and mtime
 * each file was read at. A refresh lists the roots, reads only files that
 * changed, and saves counts, never text. A snapshot answers at once with
 * what is read so far, so a first read of a large history runs in the
 * background of the summaries that ask for it.
 */
export class OutsideUsageCache {
  private readonly units = new Map<string, OutsideUnit>();
  private listed = new Map<string, { root: OutsideRoot; files: string[] | undefined; failed: Set<string> }>();
  private loaded = false;
  private dirty = false;
  private running: Promise<void> | undefined;

  constructor(private readonly file: string | undefined, private readonly now: () => number) {}

  get reading(): boolean {
    return this.running !== undefined;
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
    const listed = new Map<string, { root: OutsideRoot; files: string[] | undefined; failed: Set<string> }>();
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
    const queue = [...listed.values()].flatMap((entry) => (entry.files ?? []).map((path) => ({ entry, path })));
    let sinceSave = 0;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { entry, path } = job;
        const format = entry.root.format;
        const stamp = await stampOf(path, format);
        if (!stamp || stamp.mtimeMs < horizon) { this.drop(path); continue; }
        const cached = this.units.get(path);
        if (cached && cached.format === format && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) continue;
        // Dated by the stamp taken before the read: a file that grew meanwhile is read again next time.
        const unit = await readOutsideUnit(path, format, stamp, horizon).catch(() => undefined);
        if (!unit) { entry.failed.add(path); continue; }
        this.units.set(path, unit);
        this.dirty = true;
        if (++sinceSave >= SAVE_EVERY) { sinceSave = 0; await this.save(); }
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    for (const path of [...this.units.keys()]) if (!seen.has(path)) this.drop(path);
    await this.save();
  }

  private drop(path: string): void {
    if (this.units.delete(path)) this.dirty = true;
  }

  private async load(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as { version?: unknown; units?: unknown };
      if (stored?.version !== CACHE_VERSION || !Array.isArray(stored.units)) return;
      for (const item of stored.units) {
        const unit = decodeUnit(item);
        if (unit) this.units.set(unit.path, unit);
      }
    } catch {
      // A missing or unreadable cache only costs one full read.
    }
  }

  private async save(): Promise<void> {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, units: [...this.units.values()].map(encodeUnit) }));
      await rename(temporary, this.file);
    } catch {
      this.dirty = true;
    }
  }
}
