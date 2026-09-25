import { readFile } from "node:fs/promises";
import type { ServerFs } from "../server-fs.js";
import type { SyncIgnore } from "./ignore.js";
import { blobId, sha256Of, type MirrorState } from "./mirror.js";
import { ancestors, byPath, localPath } from "./paths.js";
import type { DriftRow, PendingRow } from "./protocol.js";
import type { Listing, ServerListing } from "./scan.js";
import { shellHashes } from "./shell.js";

/*
 * Pending: the local copy against the mirror state. Drift: the server now
 * against the mirror state. Both report deletions: a mirror path that is gone
 * from a side is a deletion unless it is ignored now, sits below a folder
 * that could not be read, or became a link.
 */

const under = (path: string, folders: readonly string[]) => folders.length > 0 && ancestors(path).some((folder) => folders.includes(folder));

/** Mirror paths a side no longer has and that count as deleted there. */
export async function deletedFrom(side: Listing, mirror: MirrorState, ignore: SyncIgnore): Promise<string[]> {
  const skipped = new Set(side.skipped);
  const missing = [...mirror.entries.keys()].filter((path) => !side.files.has(path) && !skipped.has(path) && !under(path, side.unreadable));
  const ignored = await ignore.files(missing, { ancestors: true });
  return missing.filter((path) => !ignored.has(path));
}

export interface PendingOptions {
  /** Hash every local file, not only those whose size or mtime moved. */
  thorough?: boolean;
  /** trust.json's upload block list: never pending. */
  blocklist?: readonly string[];
  signal?: AbortSignal;
}

export async function comparePending(localDir: string, local: Listing, mirror: MirrorState, ignore: SyncIgnore, options: PendingOptions = {}): Promise<{ rows: PendingRow[]; withheld: string[] }> {
  const blocked = new Set(options.blocklist ?? []);
  const rows: PendingRow[] = [];
  const withheld: string[] = [];
  for (const [path, info] of local.files) {
    options.signal?.throwIfAborted();
    if (blocked.has(path)) { withheld.push(path); continue; }
    const entry = mirror.entries.get(path);
    if (!entry) { rows.push({ path, change: "added", size: info.size }); continue; }
    if (info.size !== entry.size) { rows.push({ path, change: "modified", size: info.size }); continue; }
    // The download set the local mtime to the server's: equal means untouched since.
    if (!options.thorough && info.mtime === entry.mtime) continue;
    const data = await readFile(localPath(localDir, path)).catch(() => undefined);
    if (data && blobId(data) !== entry.oid) rows.push({ path, change: "modified", size: info.size });
  }
  for (const path of await deletedFrom(local, mirror, ignore)) {
    if (blocked.has(path)) withheld.push(path);
    else rows.push({ path, change: "deleted" });
  }
  rows.sort((a, b) => byPath(a.path, b.path));
  return { rows, withheld: withheld.sort(byPath) };
}

export interface DriftOptions {
  /** Hash every file on the server, not only those whose mtime moved. */
  thorough?: boolean;
  /** Files read at once when the server cannot hash. */
  concurrency?: number;
  signal?: AbortSignal;
  onHash?(done: number, total: number): void;
}

/** SHA-256 per path: the server's own tool where it has one, else a read over SFTP when `read`. */
async function serverHashes(fs: ServerFs, paths: readonly string[], read: boolean, options: DriftOptions): Promise<Map<string, string>> {
  const hashes = await shellHashes(fs, paths, options.signal);
  options.onHash?.(hashes.size, paths.length);
  if (!read) return hashes;
  const rest = paths.filter((path) => !hashes.has(path));
  let next = 0;
  const worker = async () => {
    while (next < rest.length) {
      const path = rest[next++]!;
      options.signal?.throwIfAborted();
      const data = await fs.read(path, { area: "project", ...(options.signal ? { signal: options.signal } : {}) }).catch(() => undefined);
      if (data) hashes.set(path, sha256Of(data));
      options.onHash?.(hashes.size, paths.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, rest.length) }, worker));
  return hashes;
}

export async function compareDrift(fs: ServerFs, server: ServerListing, mirror: MirrorState, ignore: SyncIgnore, options: DriftOptions = {}): Promise<DriftRow[]> {
  const rows: DriftRow[] = [];
  const toHash: string[] = [];
  for (const [path, info] of server.files) {
    const entry = mirror.entries.get(path);
    const stamp = { size: info.size, mtime: info.mtime };
    if (!entry) { rows.push({ path, change: "added", certain: true, server: stamp }); continue; }
    const before = { size: entry.size, mtime: entry.mtime };
    if (info.size !== entry.size) rows.push({ path, change: "modified", certain: true, server: stamp, mirror: before });
    else if (options.thorough || info.mtime !== entry.mtime) toHash.push(path);
  }
  // Same size, other mtime: a hash tells a touch from an edit.
  const hashes = toHash.length ? await serverHashes(fs, toHash, Boolean(options.thorough), options) : new Map<string, string>();
  for (const path of toHash) {
    const info = server.files.get(path)!;
    const entry = mirror.entries.get(path)!;
    const hash = hashes.get(path);
    const row: DriftRow = { path, change: "modified", certain: hash !== undefined, server: { size: info.size, mtime: info.mtime }, mirror: { size: entry.size, mtime: entry.mtime } };
    if (hash === undefined ? info.mtime !== entry.mtime : hash !== entry.sha256) rows.push(row);
  }
  for (const path of await deletedFrom(server, mirror, ignore)) {
    const entry = mirror.entries.get(path)!;
    rows.push({ path, change: "deleted", certain: true, mirror: { size: entry.size, mtime: entry.mtime } });
  }
  return rows.sort((a, b) => byPath(a.path, b.path));
}
