import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const WINDOWS_LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
// About 0.8 s in total: long enough for a scanner or indexer, short enough for a denial that never clears.
const WINDOWS_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

export interface RenameReplacingOptions {
  platform?: NodeJS.Platform;
  /** Waits before each retry; the number of entries is the number of retries. */
  delaysMs?: readonly number[];
}

/**
 * `rename` for atomic saves. Windows refuses to replace a file another process holds open
 * (virus scanner, search indexer), so it retries briefly there; other platforms rename once.
 * Keep in step with kits/_shared/atomic-rename.ts.
 */
export async function renameReplacing(from: string, to: string, options: RenameReplacingOptions = {}): Promise<void> {
  const delays = (options.platform ?? process.platform) === "win32" ? options.delaysMs ?? WINDOWS_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !WINDOWS_LOCK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await sleep(delay);
    }
  }
}

const tempPath = (path: string) => `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

/** Replaces a whole file through a temp file beside it, so a crash leaves the old contents or the new, never part. */
export async function writeFileReplacing(path: string, contents: string, mode = 0o600): Promise<void> {
  const temp = tempPath(path);
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode, flag: "wx" });
    await renameReplacing(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** `writeFileReplacing` for a file read and written before anything asynchronous runs. */
export function writeFileReplacingSync(path: string, contents: string, mode = 0o600): void {
  const temp = tempPath(path);
  try {
    writeFileSync(temp, contents, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
