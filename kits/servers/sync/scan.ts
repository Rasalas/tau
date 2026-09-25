import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { ServerPathError, type ServerFs } from "../server-fs.js";
import { SftpError } from "../sftp-client.js";
import type { SyncIgnore } from "./ignore.js";
import { ancestors, byPath, hasGitSegment, isSyncPath, localPath } from "./paths.js";
import type { ListMethod, ScanFolder, ScanSummary } from "./protocol.js";
import { collect, hasShell, LIST_SCRIPT, parseListing, type ListedEntry } from "./shell.js";

export interface FileInfo {
  size: number;
  /** Whole seconds. */
  mtime: number;
  /** Permission bits. */
  mode: number;
}

/** The files of one side after ignoring, by target-relative path. */
export interface Listing {
  files: Map<string, FileInfo>;
  /** Top-most folders left out whole. */
  ignoredFolders: string[];
  ignoredFiles: number;
  /** Symlinks and special files. */
  skipped: string[];
  /** Folders that could not be read: what the mirror has below them is neither changed nor deleted. */
  unreadable: string[];
}

export interface ServerListing extends Listing {
  method: ListMethod;
  root: string;
}

export interface ScanOptions {
  /** `auto`: the shell when the server has one. */
  method?: "auto" | ListMethod;
  /** Folders listed at once over SFTP. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(listed: number): void;
}

const below = (path: string, folders: ReadonlySet<string>) => ancestors(path).some((folder) => folders.has(folder));

/** One flat listing (the shell's `find`) through the ignore rules. */
export async function filterListing(entries: readonly ListedEntry[], ignore: SyncIgnore): Promise<Listing> {
  const valid = entries.filter((entry) => isSyncPath(entry.path));
  const ignoredDirs = await ignore.dirs(valid.filter((entry) => entry.type === "directory").map((entry) => entry.path));
  const kept = valid.filter((entry) => !below(entry.path, ignoredDirs) && !(entry.type === "directory" && ignoredDirs.has(entry.path)));
  const files = kept.filter((entry) => entry.type === "file");
  const ignoredFiles = await ignore.files(files.map((entry) => entry.path));
  const others = kept.filter((entry) => entry.type === "symlink" || entry.type === "other").map((entry) => entry.path);
  const ignoredOthers = await ignore.files(others);
  return {
    files: new Map(files.filter((entry) => !ignoredFiles.has(entry.path)).map((entry) => [entry.path, { size: entry.size, mtime: entry.mtime, mode: entry.mode }])),
    ignoredFolders: [...ignoredDirs].filter((path) => !below(path, ignoredDirs) && !hasGitSegment(path)).sort(byPath),
    ignoredFiles: ignoredFiles.size,
    skipped: others.filter((path) => !ignoredOthers.has(path)).sort(byPath),
    unreadable: [],
  };
}

/** A folder the server refused to list is a gap in the listing, not an empty folder. */
function isRefusal(error: unknown): boolean {
  if (error instanceof ServerPathError) return true;
  // 6 and 7: no connection, connection lost; those end the scan.
  return error instanceof SftpError && error.code !== 6 && error.code !== 7;
}

async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Folder by folder over SFTP, never into an ignored folder. */
async function walkServer(fs: ServerFs, ignore: SyncIgnore, options: ScanOptions): Promise<Listing> {
  const listing: Listing = { files: new Map(), ignoredFolders: [], ignoredFiles: 0, skipped: [], unreadable: [] };
  let level = [""];
  let listed = 0;
  while (level.length) {
    const children: ListedEntry[] = [];
    await pool(level, options.concurrency ?? 8, async (dir) => {
      options.signal?.throwIfAborted();
      try {
        for (const entry of await fs.list(dir, { area: "project", ...(options.signal ? { signal: options.signal } : {}) })) {
          children.push({ path: dir ? `${dir}/${entry.name}` : entry.name, type: entry.type, size: entry.size, mtime: entry.mtime, mode: entry.mode });
        }
      } catch (error) {
        if (!dir || !isRefusal(error)) throw error;
        listing.unreadable.push(dir);
      }
    });
    listed += children.length;
    options.onProgress?.(listed);
    const valid = children.filter((entry) => isSyncPath(entry.path));
    const dirs = valid.filter((entry) => entry.type === "directory").map((entry) => entry.path);
    const ignoredDirs = await ignore.dirs(dirs);
    listing.ignoredFolders.push(...[...ignoredDirs].filter((path) => !hasGitSegment(path)));
    const files = valid.filter((entry) => entry.type === "file");
    const ignoredFiles = await ignore.files(files.map((entry) => entry.path));
    listing.ignoredFiles += ignoredFiles.size;
    for (const entry of files) if (!ignoredFiles.has(entry.path)) listing.files.set(entry.path, { size: entry.size, mtime: entry.mtime, mode: entry.mode });
    const others = valid.filter((entry) => entry.type === "symlink" || entry.type === "other").map((entry) => entry.path);
    const ignoredOthers = await ignore.files(others);
    listing.skipped.push(...others.filter((path) => !ignoredOthers.has(path)));
    level = dirs.filter((path) => !ignoredDirs.has(path));
  }
  listing.ignoredFolders.sort(byPath);
  listing.skipped.sort(byPath);
  listing.unreadable.sort(byPath);
  return listing;
}

/** The server's files below `remotePath` after ignoring: one `find` with a shell, else SFTP. */
export async function scanServer(fs: ServerFs, ignore: SyncIgnore, options: ScanOptions = {}): Promise<ServerListing> {
  const method = options.method ?? "auto";
  if (method !== "sftp" && hasShell(fs)) {
    const result = await collect(await fs.execStream(LIST_SCRIPT, options.signal ? { signal: options.signal } : {}));
    const entries = result.code === 0 ? parseListing(result.stdout) : undefined;
    // A partial `find` (a folder it could not read) is not a listing; SFTP says which folder.
    if (entries) {
      options.onProgress?.(entries.length);
      return { method: "shell", root: fs.root, ...(await filterListing(entries, ignore)) };
    }
    if (method === "shell") throw new Error(`Listing over the shell failed (${result.code}): ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
  }
  return { method: "sftp", root: fs.root, ...(await walkServer(fs, ignore, options)) };
}

/** The local copy after the same rules; symbolic links are not followed. */
export async function scanLocal(root: string, ignore: SyncIgnore, options: { signal?: AbortSignal } = {}): Promise<Listing> {
  const listing: Listing = { files: new Map(), ignoredFolders: [], ignoredFiles: 0, skipped: [], unreadable: [] };
  let level = [""];
  while (level.length) {
    options.signal?.throwIfAborted();
    const dirs: string[] = [];
    const files: string[] = [];
    const others: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir ? localPath(root, dir) : root, { withFileTypes: true });
      } catch (error) {
        if (!dir && (error as NodeJS.ErrnoException).code === "ENOENT") return listing;
        if (!dir) throw error;
        listing.unreadable.push(dir);
        continue;
      }
      for (const entry of entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (!isSyncPath(path)) continue;
        if (entry.isDirectory()) dirs.push(path);
        else if (entry.isFile()) files.push(path);
        else others.push(path);
      }
    }
    const ignoredDirs = await ignore.dirs(dirs);
    listing.ignoredFolders.push(...[...ignoredDirs].filter((path) => !hasGitSegment(path)));
    const ignoredFiles = await ignore.files(files);
    listing.ignoredFiles += ignoredFiles.size;
    for (const path of files) {
      if (ignoredFiles.has(path)) continue;
      const info = await lstat(localPath(root, path)).catch(() => undefined);
      if (info?.isFile()) listing.files.set(path, { size: info.size, mtime: Math.floor(info.mtimeMs / 1000), mode: info.mode & 0o7777 });
    }
    const ignoredOthers = await ignore.files(others);
    listing.skipped.push(...others.filter((path) => !ignoredOthers.has(path)));
    level = dirs.filter((path) => !ignoredDirs.has(path));
  }
  listing.ignoredFolders.sort(byPath);
  listing.skipped.sort(byPath);
  listing.unreadable.sort(byPath);
  return listing;
}

/** Folders one and two levels down, with what a download would bring of them. */
export function folderSizes(files: ReadonlyMap<string, FileInfo>): ScanFolder[] {
  const folders = new Map<string, ScanFolder>();
  for (const [path, info] of files) {
    for (const folder of ancestors(path).slice(0, 2)) {
      const entry = folders.get(folder) ?? { path: folder, files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += info.size;
      folders.set(folder, entry);
    }
  }
  return [...folders.values()].sort((a, b) => byPath(a.path, b.path));
}

export function summarize(targetId: string, listing: ServerListing, gitRules: boolean): ScanSummary {
  let bytes = 0;
  for (const info of listing.files.values()) bytes += info.size;
  return {
    targetId,
    root: listing.root,
    method: listing.method,
    files: listing.files.size,
    bytes,
    folders: folderSizes(listing.files),
    ignoredFolders: listing.ignoredFolders,
    ignoredFiles: listing.ignoredFiles,
    skipped: listing.skipped.length,
    gitRules,
  };
}
