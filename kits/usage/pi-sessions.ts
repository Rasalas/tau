import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

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

/** What one session file billed, as of the size and mtime it was read at. */
export interface PiSessionUsage {
  path: string;
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  /** The header's time, so the original of a fork is counted before its copies. */
  createdAt: number;
  records: PiUsageRecord[];
  skippedLines: number;
}

export interface PiScan {
  /** Whether the session directory exists at all. */
  found: boolean;
  sessions: PiSessionUsage[];
  /** Files that could not be read this time. */
  failed: number;
}

const CACHE_VERSION = 1;
const READ_CONCURRENCY = 4;

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

/**
 * Reads what one Pi session file billed, the way Pi's own session stats count
 * it: assistant and tool-result messages carry usage, and so do the entries a
 * compaction or a branch summary leaves. Only lines that mention usage are
 * parsed; the bulk of a session is tool output.
 */
export async function readPiSessionUsage(path: string, stamp: { size: number; mtimeMs: number }): Promise<PiSessionUsage> {
  const records: PiUsageRecord[] = [];
  let skippedLines = 0;
  let header: Record<string, unknown> | undefined;
  let first = true;
  let lastModel = "unknown model";
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (first) {
      first = false;
      let parsed: Record<string, unknown> | undefined;
      try { parsed = object(JSON.parse(line)); } catch { skippedLines += 1; continue; }
      if (parsed?.type === "session") { header = parsed; continue; }
    }
    if (!line.includes("\"usage\"")) continue;
    let entry: Record<string, unknown> | undefined;
    try { entry = object(JSON.parse(line)); } catch { skippedLines += 1; continue; }
    if (!entry) continue;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = object(entry.usage);
      if (usage) records.push(record(entry, usage, lastModel, 1));
      continue;
    }
    if (entry.type !== "message") continue;
    const message = object(entry.message);
    const usage = object(message?.usage);
    if (!message || !usage) continue;
    if (message.role === "assistant") {
      lastModel = modelName(message) ?? lastModel;
      records.push(record(entry, usage, lastModel, 1, message));
    } else if (message.role === "toolResult") {
      records.push(record(entry, usage, lastModel, 0, message));
    }
  }
  const created = typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  return {
    path,
    ...stamp,
    sessionId: typeof header?.id === "string" ? header.id : basename(path, ".jsonl"),
    cwd: typeof header?.cwd === "string" ? header.cwd : "",
    createdAt: Number.isFinite(created) ? created : stamp.mtimeMs,
    records,
    skippedLines,
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

type StoredRecord = [key: string, at: number | null, model: number, input: number, output: number, cacheRead: number, cacheWrite: number, total: number, cost: number, requests: number];

interface StoredSession extends Omit<PiSessionUsage, "records"> {
  models: string[];
  records: StoredRecord[];
}

export function encodeSession(session: PiSessionUsage): StoredSession {
  const models: string[] = [];
  const index = (model: string) => {
    const found = models.indexOf(model);
    if (found >= 0) return found;
    models.push(model);
    return models.length - 1;
  };
  const { records, ...rest } = session;
  return {
    ...rest,
    models,
    records: records.map((item) => [item.key, item.at ?? null, index(item.model), item.input, item.output, item.cacheRead, item.cacheWrite, item.total, item.cost, item.requests]),
  };
}

export function decodeSession(value: unknown): PiSessionUsage | undefined {
  const stored = object(value);
  if (!stored || typeof stored.path !== "string" || typeof stored.sessionId !== "string" || typeof stored.cwd !== "string") return undefined;
  if (!Array.isArray(stored.models) || !Array.isArray(stored.records)) return undefined;
  const models = stored.models.map((model) => typeof model === "string" ? model : "unknown model");
  const records: PiUsageRecord[] = [];
  for (const item of stored.records) {
    if (!Array.isArray(item) || item.length !== 10 || typeof item[0] !== "string") return undefined;
    const at = typeof item[1] === "number" ? item[1] : undefined;
    records.push({
      key: item[0],
      ...(at === undefined ? {} : { at }),
      model: models[number(item[2])] ?? "unknown model",
      input: number(item[3]),
      output: number(item[4]),
      cacheRead: number(item[5]),
      cacheWrite: number(item[6]),
      total: number(item[7]),
      cost: number(item[8]),
      requests: number(item[9]),
    });
  }
  return {
    path: stored.path,
    size: number(stored.size),
    mtimeMs: number(stored.mtimeMs),
    sessionId: stored.sessionId,
    cwd: stored.cwd,
    createdAt: number(stored.createdAt),
    records,
    skippedLines: number(stored.skippedLines),
  };
}

/**
 * What every session file billed, kept by path with the size and mtime it was
 * read at. A scan lists and stats the files and reads only the ones that
 * changed; the rest come from memory, or from the cache file after a restart.
 */
export class PiUsageCache {
  private readonly sessions = new Map<string, PiSessionUsage>();
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
    let failed = 0;
    const queue = [...files];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const info = await stat(path).catch(() => undefined);
        if (!info) { failed += 1; this.sessions.delete(path); continue; }
        const cached = this.sessions.get(path);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) continue;
        // Dated by the stamp taken before the read: a file that grew meanwhile is read again next time.
        const read = await readPiSessionUsage(path, { size: info.size, mtimeMs: info.mtimeMs }).catch(() => undefined);
        if (!read) { failed += 1; this.sessions.delete(path); continue; }
        this.sessions.set(path, read);
        this.dirty = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
    this.forgetAllBut(new Set(files));
    await this.save();
    return { found: true, sessions: files.flatMap((path) => this.sessions.get(path) ?? []), failed };
  }

  private forgetAllBut(keep: Set<string>): void {
    for (const path of [...this.sessions.keys()]) {
      if (keep.has(path)) continue;
      this.sessions.delete(path);
      this.dirty = true;
    }
  }

  private async load(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const stored = object(JSON.parse(await readFile(this.file, "utf8")));
      if (stored?.version !== CACHE_VERSION || !Array.isArray(stored.sessions)) return;
      for (const item of stored.sessions) {
        const session = decodeSession(item);
        if (session) this.sessions.set(session.path, session);
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
      await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, sessions: [...this.sessions.values()].map(encodeSession) }));
      await rename(temporary, this.file);
    } catch {
      this.dirty = true;
    }
  }
}
