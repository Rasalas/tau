// Making a project from a server: what both halves share. No imports from Node,
// so the desktop half may read it.
import type { ScanFolder, ScanSummary } from "./sync/protocol.js";
import type { ServerTargetIssue, ServerTargetRow } from "./protocol.js";

/** A folder bigger than this starts deselected in the size overview (user decision 4). */
export const BIG_FOLDER_BYTES = 50 * 1024 * 1024;
/** Folders that usually hold what a project does not need locally; they start deselected at any level shown. */
export const SKIPPED_FOLDER_NAMES: readonly string[] = ["uploads", "cache", "node_modules", "vendor"];
/** What the sftp.json Tau writes leaves out, as the extension's own template does. */
export const NEW_PROJECT_IGNORE: readonly string[] = [".vscode", ".git", ".DS_Store"];

/** The server a new project comes from: an ssh alias, or an address typed in (`user@host:port`). */
export type DraftServer = { alias: string } | { address: string };

/** One folder of a server, while choosing the one a project comes from. */
export interface DraftListing {
  /** Absolute on the server, resolved. */
  path: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
  /** Files right in this folder; they are not listed. */
  files: number;
}

/** A local folder with an sftp.json, before it gets Git. */
export interface FolderInspection {
  path: string;
  /** The folder has a Git repository already; it opens as a project as it is. */
  hasGit: boolean;
  /** Nothing in it but `.vscode`: the server's files would be downloaded into it. */
  empty: boolean;
  targets: ServerTargetRow[];
  issues: ServerTargetIssue[];
}

/** What making or linking a project answers. */
export interface ProjectMade {
  workspaceId: string;
  path: string;
  commit: string;
  branch: string;
  /** Files in the first commit. */
  files: number;
  /** Where the deselected folders went: the new `.gitignore`, or `.git/info/exclude` when the server has its own `.gitignore`. */
  ignoredIn: "gitignore" | "exclude";
  liveConfigs: number;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Drops what lies below another entry; sorted, without duplicates. */
export function normalizeExcluded(paths: Iterable<string>): string[] {
  const unique = [...new Set([...paths].map((path) => path.replace(/^\/+|\/+$/gu, "")).filter(Boolean))].sort();
  return unique.filter((path) => !unique.some((other) => other !== path && under(path, other)));
}

/**
 * The folders that start deselected: any shown folder named like
 * `SKIPPED_FOLDER_NAMES`, a second-level folder over the size limit, and a
 * top folder still over it once its deselected folders are left out.
 */
export function defaultExcluded(folders: readonly ScanFolder[]): string[] {
  const excluded = new Set<string>();
  const skipped = (folder: ScanFolder) => SKIPPED_FOLDER_NAMES.includes(nameOf(folder.path).toLowerCase());
  const second = folders.filter((folder) => folder.path.includes("/"));
  for (const folder of second) if (skipped(folder) || folder.bytes > BIG_FOLDER_BYTES) excluded.add(folder.path);
  for (const folder of folders.filter((entry) => !entry.path.includes("/"))) {
    const left = folder.bytes - second.filter((child) => excluded.has(child.path) && under(child.path, folder.path)).reduce((sum, child) => sum + child.bytes, 0);
    if (skipped(folder) || left > BIG_FOLDER_BYTES) excluded.add(folder.path);
  }
  return normalizeExcluded(excluded);
}

/** What a download would still fetch with `excluded` left out. */
export function selectedTotals(summary: Pick<ScanSummary, "files" | "bytes" | "folders">, excluded: readonly string[]): { files: number; bytes: number } {
  let files = summary.files;
  let bytes = summary.bytes;
  for (const path of normalizeExcluded(excluded)) {
    const folder = summary.folders.find((entry) => entry.path === path);
    if (folder) { files -= folder.files; bytes -= folder.bytes; }
  }
  return { files, bytes };
}

/** Lines naming deselected folders from the repository's top (`context` is the target's local folder). */
export function excludedFolderLines(excluded: readonly string[], context = ""): string[] {
  const base = context ? `/${context}` : "";
  return normalizeExcluded(excluded).map((path) => `${base}/${path}/`);
}

/** The `.gitignore` of a project Tau made from a server that had none. */
export function newProjectGitignore(excluded: readonly string[], sftpJson: string): string {
  const folders = excludedFolderLines(excluded);
  return [
    ...(folders.length ? ["# Left on the server when this project was made; Tau neither downloads nor uploads them.", ...folders, ""] : []),
    "# The link to the server, for Tau and the VS Code SFTP extension; it stays on this machine.",
    `/${sftpJson}`,
    "",
  ].join("\n");
}

/**
 * sftp.json `ignore` patterns (relative to the target's folder) as lines for
 * the repository's `info/exclude`, so Git and the sync leave out the same.
 */
export function excludeLinesFor(patterns: readonly string[], context: string): string[] {
  const lines: string[] = [];
  for (const raw of patterns) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!context) { lines.push(line); continue; }
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const directory = line.endsWith("/");
    const bare = directory ? line.slice(0, -1) : line;
    const anchored = bare.includes("/");
    const path = anchored ? `/${context}/${bare.replace(/^\/+/u, "")}` : `/${context}/**/${bare}`;
    lines.push(`${negate ? "!" : ""}${path}${directory ? "/" : ""}`);
  }
  return lines;
}

/** The first commit's message, as plan-I names it. */
export function serverStateMessage(server: string, root: string, at: Date): string {
  return `Server state ${server}:${root} ${at.toISOString().slice(0, 10)}`;
}

/** A local folder name for a new project: the server folder's name, else the server's. */
export function projectFolderName(remotePath: string, server: string): string {
  const name = nameOf(remotePath.replace(/\/+$/u, ""));
  const pick = name && name !== "~" && name !== "." ? name : server;
  return pick.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+/u, "") || "server";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
