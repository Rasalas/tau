import { join, relative, sep, isAbsolute } from "node:path";

/** A path relative to the target, POSIX-style, with nothing that could climb out of it. */
export function isSyncPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `a/b/c` → `a`, `a/b`. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Tau never syncs a `.git` folder, at any depth. */
export function hasGitSegment(path: string): boolean {
  return path.split("/").includes(".git");
}

export function localPath(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
