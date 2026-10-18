import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, SessionManager, type FileEntry, type SessionHeader, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionModelCollector, type SessionModel } from "./session-model-provider.js";
import { type SessionFileStamp } from "./session-usage.js";

import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

interface StrongStamp extends SessionFileStamp { dev: number; ino: number; ctimeMs: number }
const sameStamp = (a: StrongStamp | undefined, b: StrongStamp) => a?.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.dev === b.dev && a.ino === b.ino;
async function readStamp(path: string): Promise<StrongStamp | undefined> {
  try { const info = await stat(path); return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino }; }
  catch { return undefined; }
}
interface CachedInfo {
  stamp?: StrongStamp;
  info?: SessionInfo;
  model?: SessionModel;
}

async function mapBounded<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(10, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]);
    }
  }));
  return results;
}

/** The shell fields of a session, without retaining its searchable history. */
async function readInfo(path: string, stamp: SessionFileStamp): Promise<{ info: SessionInfo; model?: SessionModel } | undefined> {
  const collector = new SessionModelCollector();
  let header: SessionHeader | undefined;
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  let lastActivity: number | undefined;
  let input: ReturnType<typeof createReadStream> | undefined;
  try {
    input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let entry: FileEntry;
      try { entry = JSON.parse(line) as FileEntry; } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      collector.add(entry);
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return undefined;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") name = entry.name?.trim() || undefined;
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown };
      if (!message || typeof message.role !== "string" || !("content" in message)) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const at = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp).getTime();
      if (!Number.isNaN(at)) lastActivity = Math.max(lastActivity ?? 0, at);
      if (!firstMessage && message.role === "user") {
        if (typeof message.content === "string") firstMessage = message.content;
        else if (Array.isArray(message.content)) firstMessage = message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text).join(" ");
      }
    }
  } catch { return undefined; }
  finally { input?.destroy(); }
  if (!header) return undefined;
  const created = new Date(header.timestamp);
  const modified = lastActivity !== undefined && lastActivity > 0 ? new Date(lastActivity)
    : !Number.isNaN(created.getTime()) ? created : new Date(stamp.mtimeMs);
  return { model: collector.model(), info: {
    path, id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "",
    name, parentSessionPath: header.parentSession, created, modified, messageCount,
    firstMessage: firstMessage || "(no messages)", allMessagesText: "",
  } };
}

/** A stat-only recovery scan; a changed file alone pays for reading its entries. */
export class SessionInfoIndex {
  private readonly cache = new Map<string, CachedInfo>();

  private restored?: Promise<void>;
  private dirty = false;
  constructor(private readonly sessionsDir?: string, private readonly options: { file?: string; logger?: PersistedJsonLogger } = {}) {}

  private restore(): Promise<void> {
    return this.restored ??= (this.options.file ? readPersistedJson(this.options.file, {
      expectedVersion: 1, decode: (raw, version) => version === 1 ? decodeInfoCache(raw) : undefined,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    }).then((read) => { for (const entry of read?.data ?? []) this.cache.set(entry.info!.path, entry); }, () => undefined) : Promise.resolve());
  }
  private async persist(): Promise<void> {
    if (!this.dirty || !this.options.file) return;
    this.dirty = false;
    try { await writePersistedJson(this.options.file, 1, { entries: [...this.cache.values()] }, this.options.logger ? { logger: this.options.logger } : {}); }
    catch { this.dirty = true; }
  }

  async list(readFiles = false): Promise<{
    infos: SessionInfo[];
    stamps: Map<string, SessionFileStamp>;
    models: Map<string, SessionModel | undefined>;
    complete: boolean;
  }> {
    await this.restore();
    const root = this.sessionsDir ?? join(getAgentDir(), "sessions");
    const direct = readFiles ? await SessionManager.listAll(this.sessionsDir) : undefined;
    const byPath = new Map(direct?.map((info) => [info.path, { ...info, allMessagesText: "" }]));
    // The SDK's full read omits failures. Verify its directory and every file
    // independently so a concurrent strict caller can trust either scan mode.
    const listing = await this.files(root);
    let complete = listing.complete;
    const files = direct ? [...new Set([...listing.paths, ...byPath.keys()])] : listing.paths;
    const retained = new Set(files);
    for (const path of this.cache.keys()) if (!retained.has(path)) { this.cache.delete(path); this.dirty = true; }
    const entries = await mapBounded(files, async (path): Promise<CachedInfo | undefined> => {
      const stamp = await readStamp(path);
      if (!stamp) { complete = false; this.cache.delete(path); return { info: byPath.get(path) }; }
      const cached = this.cache.get(path);
      if (!readFiles && sameStamp(cached?.stamp, stamp)) return cached;
      const read = await readInfo(path, stamp);
      const info = read?.info ?? byPath.get(path);
      const model = read?.model;
      const entry = { stamp, info, model };
      // A writer may append while the scan yields. Do not persist mixed metadata
      // as a reusable answer for a newer file revision.
      const after = await readStamp(path);
      if (read && after && sameStamp(stamp, after)) this.cache.set(path, entry);
      else { complete = false; this.cache.delete(path); }
      this.dirty = true;
      return entry;
    });
    const infos: SessionInfo[] = [];
    const stamps = new Map<string, SessionFileStamp>();
    const models = new Map<string, SessionModel | undefined>();
    for (const entry of entries) {
      if (!entry?.info) continue;
      infos.push(entry.info);
      if (entry.stamp) stamps.set(entry.info.path, entry.stamp);
      models.set(entry.info.id, entry.model);
    }
    infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    await this.persist();
    return { infos, stamps, models, complete: complete && entries.every((entry) => entry?.info !== undefined) };
  }

  private async files(root: string): Promise<{ paths: string[]; complete: boolean }> {
    try {
      if (this.sessionsDir) return { paths: (await readdir(root)).filter((name) => name.endsWith(".jsonl")).map((name) => join(root, name)), complete: true };
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(root, entry.name));
      let complete = true;
      const paths = (await mapBounded(directories, async (directory) => {
        try { return (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name)); }
        catch { complete = false; return []; }
      })).flat();
      return { paths, complete };
    } catch (error) { return { paths: [], complete: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
  }
}

function decodeInfoCache(raw: unknown): CachedInfo[] | undefined {
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((value): CachedInfo[] => {
    if (!value || typeof value !== "object") return [];
    const { stamp, info, model } = value as CachedInfo;
    if (!stamp || ![stamp.size, stamp.mtimeMs, stamp.ctimeMs, stamp.dev, stamp.ino].every((part) => typeof part === "number" && Number.isFinite(part))) return [];
    if (!info || typeof info.path !== "string" || typeof info.id !== "string" || typeof info.cwd !== "string" || typeof info.firstMessage !== "string" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0) return [];
    if (info.name !== undefined && typeof info.name !== "string" || info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") return [];
    const created = new Date(info.created);
    const modified = new Date(info.modified);
    if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) return [];
    if (model !== undefined && (!model || typeof model.provider !== "string" || model.id !== undefined && typeof model.id !== "string")) return [];
    return [{ stamp, info: { ...info, created, modified, allMessagesText: "" }, ...(model ? { model } : {}) }];
  });
}
