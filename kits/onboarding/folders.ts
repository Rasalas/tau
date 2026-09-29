import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/** What a found folder is to Git: a repository (with the remote clones of it share), a linked worktree, or neither. */
export type FolderGit =
  | { kind: "repository"; remote?: { key: string; label: string } }
  | { kind: "worktree" }
  | { kind: "none" };

/** The URL of `[remote "origin"]` in a Git config, if it has one. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inOrigin = /^\[remote\s+"origin"\]$/u.test(line); continue; }
    const url = inOrigin ? /^url\s*=\s*(.+)$/u.exec(line)?.[1]?.trim() : undefined;
    if (url) return url;
  }
  return undefined;
}

/**
 * One key for every spelling of a remote — `git@host:owner/name.git`,
 * `https://host/owner/name`, `ssh://git@host:22/owner/name.git` — and its
 * path as the label clones of it are grouped under.
 */
export function remoteIdentity(url: string): { key: string; label: string } | undefined {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/u.exec(url);
  let host: string | undefined;
  let path: string | undefined;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    [host, path] = [scp[1], scp[2]];
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") return undefined;
      [host, path] = [parsed.hostname, decodeURIComponent(parsed.pathname)];
    } catch {
      return undefined;
    }
  }
  const label = path?.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (!host || !label) return undefined;
  return { key: `${host.toLowerCase()}/${label.toLowerCase()}`, label };
}

/**
 * Reads `.git` directly rather than spawning Git, so a scan over many folders
 * stays cheap. A `.git` file pointing into a `worktrees/` folder is a linked
 * worktree: its history belongs to the main checkout, so it is not offered.
 */
export async function folderGit(directory: string): Promise<FolderGit> {
  const dotGit = join(directory, ".git");
  const info = await stat(dotGit).catch(() => undefined);
  if (!info) return { kind: "none" };
  let gitDir = dotGit;
  if (!info.isDirectory()) {
    const pointer = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
    if (!pointer) return { kind: "none" };
    gitDir = resolve(directory, pointer);
    if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/u.test(gitDir)) return { kind: "worktree" };
  }
  const url = originUrl(await readFile(join(gitDir, "config"), "utf8").catch(() => ""));
  const remote = url ? remoteIdentity(url) : undefined;
  return { kind: "repository", ...(remote ? { remote } : {}) };
}

export interface ExcludedFolders {
  /** Folders that are never a project themselves: the home folder and the temporary ones. */
  roots: readonly string[];
  /** Folders nothing inside of is a project: Downloads, Codex's scratch folders, Tau's worktrees. */
  ancestors: readonly string[];
}

/** What a session's folder may be without being a project worth adding. */
export function excludedFolders(home: string, env: { TAU_WORKTREES_DIR?: string } = {}, temp?: string): ExcludedFolders {
  const worktrees = env.TAU_WORKTREES_DIR?.trim();
  return {
    roots: [home, "/tmp", "/private/tmp", ...(temp ? [temp] : [])],
    ancestors: [join(home, "Downloads"), join(home, "Documents", "Codex"), ...(worktrees && isAbsolute(worktrees) ? [worktrees] : [])],
  };
}

function normalized(path: string, fold: boolean): string {
  const trimmed = path.replace(/[\\/]+$/u, "") || sep;
  return fold ? trimmed.toLowerCase() : trimmed;
}

/** Whether a folder is one of the roots or lies inside one of the ancestors; case-folded where the file system is. */
export function isExcludedFolder(path: string, excluded: ExcludedFolders, fold = process.platform === "win32" || process.platform === "darwin"): boolean {
  const target = normalized(path, fold);
  if (excluded.roots.some((root) => normalized(root, fold) === target)) return true;
  return excluded.ancestors.some((ancestor) => {
    const base = normalized(ancestor, fold);
    return target === base || target.startsWith(`${base}${sep}`) || target.startsWith(`${base}/`);
  });
}
