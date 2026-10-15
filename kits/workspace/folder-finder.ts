import type { RepositoryHost, UiFolderIndex } from "./protocol.js";

/** `/Users/me/x` reads as `~/x`; the host expands `~` again when the path is typed back. */
export function homeRelative(path: string): string {
  const home = path.match(/^\/(?:Users|home)\/[^/]+/u)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

export function withSeparator(path: string): string {
  return /[\\/]$/u.test(path) ? path : `${path}/`;
}

/** The folder part of a typed path and the name being typed after it. */
export function splitTypedPath(text: string): { folder: string; leaf: string } {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  return { folder: text.slice(0, cut), leaf: text.slice(cut) };
}

/** Text that names a host path (`~/…`, `/…`, `C:\…`) instead of something to find. */
export function isTypedPath(text: string): boolean {
  return /^(?:~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/u.test(text);
}

/** `path` below `root` as POSIX segments; "" for the root itself, undefined outside it. */
export function relativeFolder(root: string, path: string): string | undefined {
  if (path === root) return "";
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith(separator) ? root : root + separator;
  if (!path.startsWith(base)) return undefined;
  return path.slice(base.length).split(/[\\/]/u).filter(Boolean).join("/");
}

/** Joins a host folder and a POSIX path below it with the folder's own separator. */
export function joinFolder(root: string, relative: string): string {
  if (!relative) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/u, "")}${separator}${relative.split("/").join(separator)}`;
}

export const lastSegment = (path: string) => path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || path;

export interface IndexedFolder {
  /** POSIX path below the folder being searched. */
  path: string;
  name: string;
  repository?: RepositoryHost;
}

/** The index's folders below `relative` (a folder of the index), re-rooted there. */
export function foldersBelow(index: UiFolderIndex, relative: string): IndexedFolder[] {
  const prefix = relative ? `${relative}/` : "";
  const below: IndexedFolder[] = [];
  for (const folder of index.folders) {
    if (prefix && !folder.path.startsWith(prefix)) continue;
    const path = folder.path.slice(prefix.length);
    below.push({ path, name: lastSegment(path), ...(folder.repository ? { repository: folder.repository } : {}) });
  }
  return below;
}

export interface RepositoryGroup {
  /** The folder right below the browsed one that holds these repositories; "" for those directly in it. */
  key: string;
  repositories: IndexedFolder[];
}

/** Repositories grouped by the folder right below the browsed one; those directly in it come first. */
export function groupRepositories(folders: readonly IndexedFolder[]): RepositoryGroup[] {
  const groups = new Map<string, IndexedFolder[]>();
  for (const folder of folders) {
    if (!folder.repository) continue;
    const slash = folder.path.indexOf("/");
    const key = slash < 0 ? "" : folder.path.slice(0, slash);
    const list = groups.get(key) ?? [];
    list.push(folder);
    groups.set(key, list);
  }
  return [...groups].map(([key, repositories]) => ({ key, repositories })).sort((left, right) => left.key === "" ? -1 : right.key === "" ? 1 : 0);
}

export interface FolderMatch extends IndexedFolder {
  score: number;
  /** Indexes into `path` of the letters that matched. */
  marks: number[];
}

const isBoundary = (text: string, index: number) =>
  index === 0 || "/-_. ".includes(text[index - 1]!) || (/[a-z]/u.test(text[index - 1]!) && /[A-Z]/u.test(text[index]!));

/** Where `needle`'s letters occur in `hay` in order, taking a word start when one comes before the next plain hit. */
function positions(hay: string, needle: string): number[] | undefined {
  const lower = hay.toLowerCase();
  const found: number[] = [];
  let from = 0;
  for (const character of needle) {
    let at = -1;
    for (let index = from; index < lower.length; index += 1) {
      if (lower[index] !== character) continue;
      if (at < 0) at = index;
      if (isBoundary(hay, index) || (found.length > 0 && index === found[found.length - 1]! + 1)) { at = index; break; }
    }
    if (at < 0) return undefined;
    found.push(at);
    from = at + 1;
  }
  return found;
}

function scoreHit(hay: string, found: readonly number[]): number {
  let score = 0;
  found.forEach((position, index) => {
    score += 10;
    if (isBoundary(hay, position)) score += 8;
    if (index > 0 && position === found[index - 1]! + 1) score += 6;
    else if (index > 0) score -= 3 + Math.min(6, position - found[index - 1]! - 2);
  });
  if (isRun(found)) score += 15;
  return score;
}

const isRun = (found: readonly number[]) => found[found.length - 1]! - found[0]! === found.length - 1;

/** The better of a hit in the folder's own name (worth more) and one across its whole path. */
function scoreTerm(folder: IndexedFolder, term: string): { score: number; marks: number[] } | undefined {
  const inPath = positions(folder.path, term);
  if (!inPath) return undefined;
  const offset = folder.path.length - folder.name.length;
  const inName = positions(folder.name, term);
  // The name's bonus is for a run of letters; letters spread over it say less than a run in a parent.
  const nameScore = inName ? scoreHit(folder.name, inName) + (isRun(inName) ? 20 : 8) + (folder.name.toLowerCase() === term ? 30 : 0) : -Infinity;
  const pathScore = scoreHit(folder.path, inPath);
  return nameScore >= pathScore ? { score: nameScore, marks: inName!.map((position) => position + offset) } : { score: pathScore, marks: inPath };
}

/**
 * Folders whose path holds every space-separated word of `query` in order, fzf-style:
 * word starts and runs of letters count most, then repositories, then shallow folders.
 */
export function rankFolders(folders: readonly IndexedFolder[], query: string, limit = 40): FolderMatch[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return [];
  const matches: FolderMatch[] = [];
  for (const folder of folders) {
    let score = 0;
    const marks = new Set<number>();
    let matched = true;
    for (const term of terms) {
      const hit = scoreTerm(folder, term);
      if (!hit) { matched = false; break; }
      score += hit.score;
      for (const mark of hit.marks) marks.add(mark);
    }
    if (!matched) continue;
    score += folder.repository ? 14 : 0;
    score -= folder.path.split("/").length * 3;
    matches.push({ ...folder, score, marks: [...marks].sort((left, right) => left - right) });
  }
  return matches.sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path)).slice(0, limit);
}
