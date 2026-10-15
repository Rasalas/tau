import type { Dirent } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { knownService, remoteHost } from "../_git-hosts/hosts.js";
import type { RepositoryHost, UiFolderIndex } from "./protocol.js";

const MAX_DEPTH = 6;
const MAX_FOLDERS = 30_000;
const TIME_BUDGET_MS = 8_000;
const CONCURRENCY = 32;
/** A cached index answers at once for this long; past `FRESH_MS` it is walked again behind that answer. */
const CACHE_MS = 10 * 60_000;
const FRESH_MS = 30_000;
const CACHE_ENTRIES = 4;

/** Build output and caches that hold no project; a checkout is never entered, so these only matter around one. */
const SKIPPED_NAMES = new Set(["node_modules", "__pycache__", "Pods", "DerivedData", "bower_components"]);

/**
 * Folders a walk never enters unless it started inside them: system trees, mounted volumes,
 * and the home folders macOS guards with a permission prompt (a walk of `~` must not raise one).
 */
function protectedFolders(): Set<string> {
  const home = homedir();
  if (process.platform === "darwin") {
    return new Set([
      ...["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications"].map((name) => join(home, name)),
      ...["/Applications", "/Library", "/System", "/Volumes", "/private", "/cores", "/dev", "/opt", "/usr", "/bin", "/sbin", "/etc", "/var", "/tmp"],
    ]);
  }
  if (process.platform === "win32") {
    const drive = parse(home).root;
    return new Set([join(home, "AppData"), ...["Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin"].map((name) => join(drive, name))]);
  }
  return new Set(["/proc", "/sys", "/dev", "/run", "/snap", "/usr", "/var", "/etc", "/boot", "/lib", "/lib64", "/bin", "/sbin", "/tmp", "/mnt", "/media", "/lost+found"]);
}

async function gitConfig(repository: string, dotGit: Dirent): Promise<string> {
  const marker = join(repository, ".git");
  if (dotGit.isDirectory()) return readFile(join(marker, "config"), "utf8");
  // A linked worktree or submodule: `.git` names the real Git directory.
  const gitdir = resolve(repository, /gitdir:\s*(.+)/u.exec(await readFile(marker, "utf8"))?.[1]?.trim() ?? "");
  const common = await readFile(join(gitdir, "commondir"), "utf8").then((text) => resolve(gitdir, text.trim()), () => gitdir);
  return readFile(join(common, "config"), "utf8");
}

/** The host `origin` points at, by name; "git" for a repository without a remote Tau knows. */
export async function repositoryHost(repository: string, dotGit: Dirent): Promise<RepositoryHost> {
  try {
    const config = await gitConfig(repository, dotGit);
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/u.exec(config)?.[1] ?? /\burl\s*=\s*(\S+)/u.exec(config)?.[1];
    const host = remoteHost(url);
    return (host && knownService(host)) || "git";
  } catch {
    return "git";
  }
}

/** The repository a folder is, read off its own entries; undefined for a plain folder. */
export async function repositoryOf(path: string, entries?: readonly Dirent[]): Promise<RepositoryHost | undefined> {
  const list = entries ?? await readdir(path, { withFileTypes: true }).catch(() => []);
  const dotGit = list.find((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()));
  return dotGit ? repositoryHost(path, dotGit) : undefined;
}

/**
 * Every folder below `root` the folder finder searches, parents before children.
 * A repository is a leaf: its own folders are browsed, not indexed. Hidden folders,
 * symlinks and the protected trees above are skipped; the walk stops at its depth,
 * its size and its time budget.
 */
export async function indexFolders(requested: string, limits: { maxDepth?: number; maxFolders?: number; budgetMs?: number } = {}): Promise<UiFolderIndex> {
  if (!isAbsolute(requested)) throw new Error("Choose an absolute folder path.");
  const root = await realpath(requested);
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const maxFolders = limits.maxFolders ?? MAX_FOLDERS;
  const deadline = Date.now() + (limits.budgetMs ?? TIME_BUDGET_MS);
  // Only children are checked, so a protected folder the walk starts in is still walked.
  const skip = protectedFolders();
  const folders: UiFolderIndex["folders"] = [];
  let truncated = false;
  let level: Array<{ path: string; relative: string }> = [{ path: root, relative: "" }];

  for (let depth = 0; level.length > 0; depth += 1) {
    const next: typeof level = [];
    await pool(level, CONCURRENCY, async (folder) => {
      if (truncated) return;
      if (Date.now() > deadline || folders.length >= maxFolders) { truncated = true; return; }
      const entries = await readdir(folder.path, { withFileTypes: true }).catch(() => undefined);
      if (!entries) return;
      if (folders.length >= maxFolders) { truncated = true; return; }
      if (folder.relative) {
        const repository = await repositoryOf(folder.path, entries);
        folders.push({ path: folder.relative, ...(repository ? { repository } : {}) });
        if (repository) return;
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) continue;
        const path = join(folder.path, entry.name);
        if (skip.has(path)) continue;
        next.push({ path, relative: folder.relative ? `${folder.relative}/${entry.name}` : entry.name });
      }
    });
    if (truncated) break;
    level = next;
  }
  folders.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return { root, folders, truncated };
}

async function pool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let at = 0;
  const worker = async () => { while (at < items.length) await run(items[at++]!); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** One walk per folder, answered from memory while a newer walk runs behind it. */
export function createFolderIndexCache(index: (root: string) => Promise<UiFolderIndex> = (root) => indexFolders(root), now: () => number = Date.now) {
  const entries = new Map<string, { at: number; result: Promise<UiFolderIndex>; refreshing?: boolean }>();
  const walk = (key: string) => {
    const result = index(key);
    const entry = { at: now(), result };
    entries.delete(key);
    entries.set(key, entry);
    result.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
    for (const old of [...entries.keys()].slice(0, Math.max(0, entries.size - CACHE_ENTRIES))) entries.delete(old);
    return result;
  };
  return async (root: string): Promise<UiFolderIndex> => {
    const key = await realpath(root).catch(() => root);
    const cached = entries.get(key);
    if (!cached || now() - cached.at >= CACHE_MS) return walk(key);
    if (now() - cached.at >= FRESH_MS && !cached.refreshing) {
      cached.refreshing = true;
      // The old answer stays until the new walk has one.
      void index(key).then((result) => { entries.set(key, { at: now(), result: Promise.resolve(result) }); }, () => { cached.refreshing = false; });
    }
    return cached.result;
  };
}
