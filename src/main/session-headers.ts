import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HostSessionSummary } from "./host-extensions.js";

/** Pi's own bound for a header line (`MAX_SESSION_HEADER_SCAN_BYTES`). */
const MAX_HEADER_BYTES = 1024 * 1024;
const CHUNK_BYTES = 4096;
const CONCURRENCY = 16;

interface Stamp { size: number; mtimeMs: number; dev: number; ino: number }
const sameStamp = (a: Stamp, b: Stamp) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;

/** The first parsed entry when it is a session header, as Pi's `listAll` accepts one; blank and malformed lines are skipped. */
export async function readSessionHeader(path: string): Promise<{ id: string; cwd: string } | undefined> {
  const file = await open(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let line = "";
    let scanned = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null);
      const text = bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      scanned += bytesRead;
      let start = 0;
      for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
        const verdict = headerOf(line + text.slice(start, newline));
        if (verdict !== "skip") return verdict;
        line = "";
        start = newline + 1;
      }
      line += text.slice(start);
      if (bytesRead === 0) {
        const verdict = headerOf(line);
        return verdict === "skip" ? undefined : verdict;
      }
      if (scanned >= MAX_HEADER_BYTES) return undefined;
    }
  } finally {
    await file.close();
  }
}

function headerOf(line: string): { id: string; cwd: string } | undefined | "skip" {
  if (!line.trim()) return "skip";
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return "skip"; }
  const header = entry as { type?: unknown; id?: unknown; cwd?: unknown } | null;
  if (!header || header.type !== "session" || typeof header.id !== "string") return undefined;
  return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "" };
}

/**
 * Every Pi session on disk by its header alone. `SessionManager.listAll` parses
 * every entry of every file, which kits paid for on each `sessions.list()`.
 */
export class SessionHeaderIndex {
  private readonly cache = new Map<string, { stamp: Stamp; summary: HostSessionSummary | undefined }>();

  constructor(private readonly sessionsDir: string | undefined) {}

  async list(): Promise<HostSessionSummary[]> {
    const files = await this.files();
    const found: Array<{ summary: HostSessionSummary; mtimeMs: number }> = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const path = files[next++]!;
        const entry = await this.read(path);
        if (entry) found.push(entry);
      }
    }));
    const listed = new Set(files);
    for (const path of this.cache.keys()) if (!listed.has(path)) this.cache.delete(path);
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.summary);
  }

  private async read(path: string): Promise<{ summary: HostSessionSummary; mtimeMs: number } | undefined> {
    let stamp: Stamp;
    try {
      const info = await stat(path);
      stamp = { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
    } catch {
      this.cache.delete(path);
      return undefined;
    }
    const cached = this.cache.get(path);
    let summary = cached?.summary;
    if (!cached || !sameStamp(cached.stamp, stamp)) {
      const header = await readSessionHeader(path).catch(() => undefined);
      summary = header ? { sessionId: header.id, path, cwd: header.cwd } : undefined;
      this.cache.set(path, { stamp, summary });
    }
    return summary ? { summary, mtimeMs: stamp.mtimeMs } : undefined;
  }

  /** The files `listAll` reads: the override's own `.jsonl` files, else one folder per project under Pi's `sessions/`. */
  private async files(): Promise<string[]> {
    const root = this.sessionsDir ?? join(getAgentDir(), "sessions");
    const jsonl = async (directory: string) => (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
    try {
      if (this.sessionsDir) return await jsonl(root);
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(root, entry.name));
      return (await Promise.all(directories.map((directory) => jsonl(directory).catch(() => [])))).flat();
    } catch {
      return [];
    }
  }
}
