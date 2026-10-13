import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, type FileEntry, type SessionHeader, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { readSessionModel, type SessionModel } from "./session-model-provider.js";
import { readSessionFileStamp, type SessionFileStamp } from "./session-usage.js";

interface CachedInfo {
  stamp: SessionFileStamp;
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
async function readInfo(path: string, stamp: SessionFileStamp): Promise<SessionInfo | undefined> {
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
  return {
    path, id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "",
    name, parentSessionPath: header.parentSession, created, modified, messageCount,
    firstMessage: firstMessage || "(no messages)", allMessagesText: "",
  };
}

/** A stat-only recovery scan; a changed file alone pays for reading its entries. */
export class SessionInfoIndex {
  private readonly cache = new Map<string, CachedInfo>();

  constructor(private readonly sessionsDir?: string) {}

  async list(): Promise<{
    infos: SessionInfo[];
    stamps: Map<string, SessionFileStamp>;
    models: Map<string, SessionModel | undefined>;
  }> {
    const root = this.sessionsDir ?? join(getAgentDir(), "sessions");
    const files = await this.files(root);
    const retained = new Set(files);
    for (const path of this.cache.keys()) if (!retained.has(path)) this.cache.delete(path);
    const entries = await mapBounded(files, async (path) => {
      const stamp = await readSessionFileStamp(path);
      if (!stamp) { this.cache.delete(path); return undefined; }
      const cached = this.cache.get(path);
      if (cached?.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) return cached;
      const info = await readInfo(path, stamp);
      const model = info ? await readSessionModel(path) : undefined;
      const entry = { stamp, info, model };
      if (info) this.cache.set(path, entry);
      else this.cache.delete(path);
      return entry;
    });
    const infos: SessionInfo[] = [];
    const stamps = new Map<string, SessionFileStamp>();
    const models = new Map<string, SessionModel | undefined>();
    for (const entry of entries) {
      if (!entry?.info) continue;
      infos.push(entry.info);
      stamps.set(entry.info.path, entry.stamp);
      models.set(entry.info.id, entry.model);
    }
    infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return { infos, stamps, models };
  }

  private async files(root: string): Promise<string[]> {
    try {
      if (this.sessionsDir) return (await readdir(root)).filter((name) => name.endsWith(".jsonl")).map((name) => join(root, name));
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(root, entry.name));
      return (await mapBounded(directories, async (directory) => {
        try { return (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name)); }
        catch { return []; }
      })).flat();
    } catch { return []; }
  }
}
