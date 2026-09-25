import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SecretFinding } from "../live-config.js";
import { scanText } from "../secrets-scan.js";
import type { ServerFs } from "../server-fs.js";
import { isNoSuchFile, SftpError } from "../sftp-client.js";
import { blobId, entryOf, type Mirror, type MirrorEntry, type MirrorState } from "./mirror.js";
import { ancestors, isInside, localPath } from "./paths.js";
import type { FetchMethod } from "./protocol.js";
import type { FileInfo, ServerListing } from "./scan.js";
import { hasShell, NO_TAR, pathList, TAR_SCRIPT } from "./shell.js";
import { readTar, TarError } from "./tar.js";

/*
 * A full copy of the server's files into the local folder and the mirror.
 * Local work is never lost: a local file that differs from the last mirror
 * state stays (it shows as pending), and a file deleted locally since stays
 * deleted, unless the caller asks to overwrite. What the server deleted goes
 * locally only while it holds no local work, so an upload cannot bring it back.
 */

export interface DownloadOptions {
  localDir: string;
  /** Replace local files that differ and bring back ones deleted locally. */
  overwrite?: boolean;
  method?: "auto" | FetchMethod;
  /** Files read at once over SFTP. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(done: number, bytes: number): void;
  /**
   * Mirror paths the server no longer has (and that are not ignored now). A
   * local file that still holds the mirror's content goes too; one with local
   * changes stays and shows as pending.
   */
  deletedOnServer?: readonly string[];
  /** Records the server in the mirror only; the local folder is not touched (a folder that holds the site already). */
  mirrorOnly?: boolean;
}

export interface DownloadOutcome {
  method: FetchMethod;
  /** The new mirror state: what came down, plus the last known state below folders that could not be read. */
  entries: Map<string, MirrorEntry>;
  bytes: number;
  written: number;
  unchanged: number;
  kept: string[];
  keptDeleted: string[];
  removed: string[];
  failed: Array<{ path: string; message: string }>;
  findings: SecretFinding[];
}

const SCAN_LIMIT = 1024 * 1024;

class LocalCopy {
  private root: string | undefined;

  constructor(private readonly dir: string) {}

  private async realRoot(): Promise<string> {
    if (!this.root) {
      await mkdir(this.dir, { recursive: true });
      this.root = await realpath(this.dir);
    }
    return this.root;
  }

  /**
   * What became of the local file; throws when it cannot be written. A local
   * file that still holds the previous mirror state is not local work: the
   * server's newer content replaces it.
   */
  async place(path: string, data: Buffer, entry: MirrorEntry, previous: MirrorEntry | undefined, overwrite: boolean): Promise<"written" | "unchanged" | "kept" | "kept-deleted"> {
    const root = await this.realRoot();
    const file = localPath(root, path);
    const info = await lstat(file).catch(() => undefined);
    if (!info) {
      if (previous && !overwrite) return "kept-deleted";
    } else if (!info.isFile()) {
      return "kept";
    } else {
      const worthReading = info.size === data.length || info.size === previous?.size;
      const localOid = worthReading ? blobId(await readFile(file)) : undefined;
      if (localOid === entry.oid) {
        // Same content: the server's mtime lets the next compare skip the hash.
        await utimes(file, entry.mtime, entry.mtime);
        return "unchanged";
      }
      if (!overwrite && localOid !== previous?.oid) return "kept";
    }
    const parent = dirname(file);
    await mkdir(parent, { recursive: true });
    // A local folder link must not carry a write out of the project.
    if (!isInside(await realpath(parent), root)) throw new Error("leads out of the local folder through a link");
    const temp = join(parent, `.${basename(file)}.tau-${randomBytes(4).toString("hex")}`);
    try {
      await writeFile(temp, data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
      await utimes(temp, entry.mtime, entry.mtime);
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return "written";
  }

  /** Removes the local file only while it holds exactly `previous`. */
  async removeIfUnchanged(path: string, previous: MirrorEntry): Promise<boolean> {
    const root = await this.realRoot();
    const file = localPath(root, path);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.size !== previous.size) return false;
    if (!isInside(await realpath(dirname(file)), root)) return false;
    if (blobId(await readFile(file)) !== previous.oid) return false;
    await rm(file);
    return true;
  }
}

function isText(data: Buffer): boolean {
  return data.length <= SCAN_LIMIT && !data.subarray(0, 8000).includes(0);
}

export async function download(fs: ServerFs, listing: ServerListing, previous: MirrorState | undefined, mirror: Mirror, options: DownloadOptions): Promise<DownloadOutcome> {
  const outcome: DownloadOutcome = { method: "sftp", entries: new Map(), bytes: 0, written: 0, unchanged: 0, kept: [], keptDeleted: [], removed: [], failed: [], findings: [] };
  const local = new LocalCopy(options.localDir);
  await mirror.ensure();
  let done = 0;

  const receive = async (path: string, data: Buffer, stamp: { mtime: number; mode: number }) => {
    const entry = entryOf(data, stamp);
    await mirror.writeBlob(data);
    outcome.entries.set(path, entry);
    outcome.bytes += data.length;
    if (isText(data)) outcome.findings.push(...scanText(path, data.toString("utf8")));
    if (options.mirrorOnly) {
      options.onProgress?.(++done, outcome.bytes);
      return;
    }
    try {
      const placed = await local.place(path, data, entry, previous?.entries.get(path), Boolean(options.overwrite));
      if (placed === "written") outcome.written += 1;
      else if (placed === "unchanged") outcome.unchanged += 1;
      else if (placed === "kept") outcome.kept.push(path);
      else outcome.keptDeleted.push(path);
    } catch (error) {
      outcome.failed.push({ path, message: `could not be written here: ${(error as Error).message}` });
    }
    done += 1;
    options.onProgress?.(done, outcome.bytes);
  };

  const wanted = new Map<string, FileInfo>(listing.files);
  if (options.method !== "sftp" && hasShell(fs) && wanted.size > 0) {
    const stop = new AbortController();
    const abort = () => stop.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const stream = await fs.execStream(TAR_SCRIPT, { input: pathList(wanted.keys()), signal: stop.signal });
    try {
      for await (const entry of readTar(stream.stdout)) {
        const path = entry.name.replace(/^\.\//u, "");
        if (entry.type !== "file" || !wanted.has(path)) continue;
        wanted.delete(path);
        await receive(path, entry.data, { mtime: entry.mtime, mode: entry.mode });
      }
    } catch (error) {
      stop.abort();
      // A damaged stream ends the tar part; SFTP fetches the rest.
      if (!(error instanceof TarError)) throw error;
    } finally {
      stream.stdout.resume();
      options.signal?.removeEventListener("abort", abort);
    }
    const result = await stream.done;
    if (result.code !== NO_TAR) outcome.method = "tar";
    options.signal?.throwIfAborted();
  }

  // What tar did not bring (no tar, a hard link, a name it mangled) comes over SFTP.
  const rest = [...wanted];
  let next = 0;
  const worker = async () => {
    while (next < rest.length) {
      const [path, info] = rest[next++]!;
      options.signal?.throwIfAborted();
      let data: Buffer;
      let stamp = { mtime: info.mtime, mode: info.mode };
      try {
        data = await fs.read(path, { area: "project", ...(options.signal ? { signal: options.signal } : {}) });
        // Changed since the listing: the stamp must belong to this content.
        if (data.length !== info.size) stamp = await fs.stat(path, { area: "project" });
      } catch (error) {
        if (isNoSuchFile(error)) continue;
        if (!(error instanceof SftpError)) throw error;
        outcome.failed.push({ path, message: error.message });
        continue;
      }
      await receive(path, data, stamp);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, rest.length) }, worker));

  // Below a folder the server would not list, or a file it would not give, the last known state stays.
  const failed = new Set(outcome.failed.map((entry) => entry.path));
  for (const [path, entry] of previous?.entries ?? []) {
    if (outcome.entries.has(path)) continue;
    if (failed.has(path) || ancestors(path).some((folder) => listing.unreadable.includes(folder))) outcome.entries.set(path, entry);
  }
  for (const path of options.mirrorOnly ? [] : options.deletedOnServer ?? []) {
    const entry = previous?.entries.get(path);
    if (!entry || outcome.entries.has(path)) continue;
    try {
      if (await local.removeIfUnchanged(path, entry)) outcome.removed.push(path);
    } catch (error) {
      outcome.failed.push({ path, message: `could not be removed here: ${(error as Error).message}` });
    }
  }
  outcome.kept.sort();
  outcome.keptDeleted.sort();
  outcome.removed.sort();
  return outcome;
}
