import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HostCommandError } from "tau/host-extension";
import type { GitRunner } from "./git.js";
import type { IgnoredCandidate, IgnoredFilePayload, IgnoredSkipped } from "./protocol.js";

/**
 * Ignored files are not part of the bundle. The user often keeps some that a
 * thread there needs — a `.env` for running locally, an ignored issue folder —
 * so Tau offers the small, non-build ones once per project and sends what the
 * user ticked, inside the call to their own machine (user decision 3, plan-H).
 */

/** Dependencies, builds and caches: never offered, however small. */
const BUILD_SEGMENTS = new Set([
  "node_modules", "bower_components", "jspm_packages", "vendor", "dist", "build", "out", "target", "coverage", ".nyc_output",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".vite", ".angular", ".expo", ".gradle", ".idea",
  ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".terraform", ".serverless",
  "DerivedData", "Pods", ".dart_tool", ".tau-dev", "tmp", "temp", "logs",
]);
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SYSTEM_SUFFIXES = [".log", ".pid", ".lock", ".tmp", ".swp", ".pyc", ".class", ".o", ".so", ".dylib", ".dll", ".exe"];
const ISSUE_FOLDERS = /^(?:\.?scratch|\.?issues?|\.?notes?|\.?todos?|\.?tasks?|\.?plans?|\.?drafts?)$/iu;

/** A file Tau offers at most this large; a folder at most this much in all. */
export const OFFER_FILE_BYTES = 256 * 1024;
export const OFFER_FOLDER_BYTES = 2 * 1024 * 1024;
export const OFFER_FOLDER_FILES = 400;
/** What one transfer carries at most. */
export const SEND_FILE_BYTES = 1024 * 1024;
export const SEND_TOTAL_BYTES = 16 * 1024 * 1024;
export const SEND_FILES = 2000;
const SKIPPED_SHOWN = 40;

const isBuildPath = (path: string) => path.split("/").some((segment) => BUILD_SEGMENTS.has(segment) || segment.startsWith("dist-"));
const isSystemFile = (path: string) => {
  const name = path.split("/").pop() ?? path;
  return SYSTEM_FILES.has(name) || SYSTEM_SUFFIXES.some((suffix) => name.endsWith(suffix));
};
const isEnvFile = (path: string) => /^\.env(?:\..+)?$/u.test(path.split("/").pop() ?? "") || /\.env$/u.test(path);

async function isText(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Regular files below `folder`, relative to `root`; stops early once past `limit`. */
async function walk(root: string, folder: string, limit: number): Promise<Array<{ path: string; size: number }>> {
  const found: Array<{ path: string; size: number }> = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (found.length > limit || depth > 8) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length > limit) return;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) found.push({ path: relative(root, full).split(sep).join("/"), size: (await lstat(full)).size });
    }
  };
  await visit(join(root, folder), 0);
  return found;
}

/** Ignored, untracked paths as Git lists them, a whole ignored folder as one entry ending in `/`. */
async function ignoredEntries(root: string, git: GitRunner): Promise<string[]> {
  const output = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]);
  return output.split("\0").filter(Boolean);
}

/** The ignored paths of a checkout, split into what Tau offers to send along and what it never does. */
export async function suggestIgnoredFiles(root: string, git: GitRunner): Promise<{ candidates: IgnoredCandidate[]; skipped: IgnoredSkipped[] }> {
  const candidates: IgnoredCandidate[] = [];
  const skipped: IgnoredSkipped[] = [];
  for (const entry of await ignoredEntries(root, git)) {
    const folder = entry.endsWith("/");
    const path = folder ? entry.slice(0, -1) : entry;
    if (isBuildPath(path)) { skipped.push({ path: entry, why: "build" }); continue; }
    if (!folder) {
      const info = await lstat(join(root, path)).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (isEnvFile(path) && info.size <= OFFER_FILE_BYTES) { candidates.push({ path, kind: "file", reason: "env", files: 1, bytes: info.size }); continue; }
      if (isSystemFile(path)) { skipped.push({ path, why: "system" }); continue; }
      if (info.size > OFFER_FILE_BYTES) { skipped.push({ path, why: "large" }); continue; }
      if (!await isText(join(root, path)).catch(() => false)) { skipped.push({ path, why: "binary" }); continue; }
      candidates.push({ path, kind: "file", reason: "text", files: 1, bytes: info.size });
      continue;
    }
    const files = (await walk(root, path, OFFER_FOLDER_FILES)).filter((file) => !isBuildPath(file.path) && !isSystemFile(file.path));
    if (files.length === 0) continue;
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > OFFER_FOLDER_FILES || bytes > OFFER_FOLDER_BYTES || files.some((file) => file.size > OFFER_FILE_BYTES)) {
      skipped.push({ path: entry, why: "large" });
      continue;
    }
    const text = await Promise.all(files.map((file) => isText(join(root, file.path)).catch(() => false)));
    if (text.some((value) => !value)) { skipped.push({ path: entry, why: "binary" }); continue; }
    const issues = path.split("/").some((segment) => ISSUE_FOLDERS.test(segment));
    candidates.push({ path: entry, kind: "folder", reason: issues ? "issues" : "text", files: files.length, bytes });
  }
  const order = { env: 0, issues: 1, text: 2 } as const;
  candidates.sort((left, right) => order[left.reason] - order[right.reason] || left.path.localeCompare(right.path));
  return { candidates, skipped: skipped.slice(0, SKIPPED_SHOWN) };
}

/** A relative path that stays inside its folder and out of `.git`. */
export function safeRelativePath(path: string): string | undefined {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path) || /^[a-z]:/iu.test(path)) return undefined;
  const clean = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  const segments = clean.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "") || segments[0].toLowerCase() === ".git") return undefined;
  return clean;
}

/**
 * The files the chosen paths hold, still ignored and untracked, read for the
 * call. Tracked files are part of the bundle already and never read here.
 */
export async function collectIgnoredFiles(root: string, paths: readonly string[], git: GitRunner): Promise<IgnoredFilePayload[]> {
  const chosen = paths.map((path) => safeRelativePath(path)).filter((path): path is string => Boolean(path));
  if (chosen.length === 0) return [];
  const output = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...chosen]);
  const files = output.split("\0").filter(Boolean).filter((path) => !isBuildPath(path) && !isSystemFile(path) && safeRelativePath(path));
  if (files.length > SEND_FILES) throw new HostCommandError(`The ignored files chosen for this project are ${files.length} files; at most ${SEND_FILES} go along. Untick a folder in Settings → Remote work.`);
  const payload: IgnoredFilePayload[] = [];
  let total = 0;
  for (const path of files) {
    const full = join(root, path);
    const info = await lstat(full).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > SEND_FILE_BYTES) throw new HostCommandError(`${path} is ${Math.ceil(info.size / 1024)} KB; an ignored file goes along only up to ${SEND_FILE_BYTES / 1024} KB.`);
    total += info.size;
    if (total > SEND_TOTAL_BYTES) throw new HostCommandError(`The ignored files chosen for this project are more than ${SEND_TOTAL_BYTES / 1024 / 1024} MB together.`);
    payload.push({ path, mode: info.mode & 0o111 ? 0o755 : 0o644, data: (await readFile(full)).toString("base64") });
  }
  return payload;
}

/**
 * Writes files a transfer carried into a new worktree. A path that would leave
 * it, reach into `.git`, or replace a file the bundle brought is refused.
 */
export async function writeIgnoredFiles(worktree: string, files: readonly IgnoredFilePayload[]): Promise<{ written: number; refused: string[] }> {
  const refused: string[] = [];
  let written = 0;
  let total = 0;
  const top = resolve(worktree);
  for (const file of files.slice(0, SEND_FILES)) {
    const path = safeRelativePath(file?.path);
    const data = typeof file?.data === "string" ? Buffer.from(file.data, "base64") : undefined;
    const target = path ? resolve(top, path) : undefined;
    total += data?.length ?? 0;
    if (!path || !data || !target || !target.startsWith(top + sep) || data.length > SEND_FILE_BYTES || total > SEND_TOTAL_BYTES) {
      refused.push(String(file?.path));
      continue;
    }
    if (await lstat(target).then(() => true, () => false)) {
      refused.push(path);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    // A folder on the way that is a symlink could point out of the worktree.
    if (!(await realParentInside(top, dirname(target)))) {
      refused.push(path);
      continue;
    }
    await writeFile(target, data, { mode: file.mode === 0o755 ? 0o755 : 0o644, flag: "wx" });
    written += 1;
  }
  return { written, refused };
}

async function realParentInside(top: string, folder: string): Promise<boolean> {
  const [realTop, realFolder] = await Promise.all([realpath(top), realpath(folder)]);
  return realFolder === realTop || realFolder.startsWith(realTop + sep);
}
