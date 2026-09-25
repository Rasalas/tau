import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hasGitSegment, isInside, localPath } from "./paths.js";

/*
 * The target's local folder: files read for an upload and written when the
 * user takes the server's version or merges it. Only regular files inside
 * the folder, never through a link out of it, never in `.git`.
 */

export interface LocalFile {
  data: Buffer;
  /** Permission bits. */
  mode: number;
}

/** A regular file inside the target's folder; nothing through a link, nothing in `.git`. */
export async function readLocalFile(localDir: string, path: string): Promise<LocalFile | undefined> {
  if (hasGitSegment(path)) return undefined;
  const file = localPath(localDir, path);
  try {
    const [info, real, root] = await Promise.all([lstat(file), realpath(file), realpath(localDir)]);
    if (!info.isFile() || !isInside(real, root)) return undefined;
    return { data: await readFile(real), mode: info.mode & 0o7777 };
  } catch {
    return undefined;
  }
}

async function checkedParent(localDir: string, path: string): Promise<{ file: string; parent: string }> {
  if (hasGitSegment(path)) throw new Error(`Tau does not write into .git: ${path}`);
  const root = await realpath(localDir);
  const file = localPath(root, path);
  const parent = dirname(file);
  await mkdir(parent, { recursive: true });
  // A local folder link must not carry a write out of the project.
  if (!isInside(await realpath(parent), root)) throw new Error(`${path} leads out of the local folder through a link.`);
  const info = await lstat(file).catch(() => undefined);
  if (info && !info.isFile()) throw new Error(`${path} is no regular file here.`);
  return { file, parent };
}

/** Replaces a local file through a temp file and a rename; `mtime` in seconds. */
export async function writeLocalFile(localDir: string, path: string, data: Buffer, options: { mode: number; mtime?: number }): Promise<void> {
  const { file, parent } = await checkedParent(localDir, path);
  const temp = join(parent, `.${basename(file)}.tau-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(temp, data, { mode: options.mode });
    if (options.mtime !== undefined) await utimes(temp, options.mtime, options.mtime);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function removeLocalFile(localDir: string, path: string): Promise<boolean> {
  const { file } = await checkedParent(localDir, path);
  const info = await lstat(file).catch(() => undefined);
  if (!info) return false;
  await rm(file);
  return true;
}

/** Conflict markers as `git merge-file` leaves them: an upload of such a file would put them live. */
export function hasConflictMarkers(data: Buffer): boolean {
  if (data.subarray(0, 8000).includes(0)) return false;
  const text = data.toString("utf8");
  return /^<{7}(?: |$)/mu.test(text) && /^={7}\r?$/mu.test(text) && /^>{7}(?: |$)/mu.test(text);
}
