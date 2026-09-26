import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultLockStrategy, lockHeld, lockOwner, tryLock, type LockOwner, type LockStrategy, type ProcessLock } from "./process-lock.js";

/** A host that found its data folder owned by another exits with this, not with a crash's code. */
export const DATA_FOLDER_BUSY_EXIT_CODE = 75;

/** `<userData>/host.lock`: one host per data folder, held by the OS for as long as that host lives. */
export function dataFolderLockPath(userData: string): string {
  return join(userData, "host.lock");
}

export interface DataFolderLockOptions {
  strategy?: LockStrategy;
  /** How long to wait for a holder that is on its way out. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Takes this data folder for the calling host. Nothing that reads markers or
 * writes sessions may run before this answered with a lock.
 */
export async function claimDataFolder(userData: string, options: DataFolderLockOptions = {}): Promise<ProcessLock | undefined> {
  const path = dataFolderLockPath(userData);
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), dataFolder: userData };
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    const lock = await tryLock(path, owner, options.strategy ?? defaultLockStrategy());
    if (lock || Date.now() >= deadline) return lock;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
}

export function dataFolderBusy(userData: string, strategy: LockStrategy = defaultLockStrategy()): Promise<boolean> {
  return lockHeld(dataFolderLockPath(userData), strategy);
}

/** Resolves true once no host holds the data folder, false when `timeoutMs` passed first. */
export async function waitForDataFolderFree(userData: string, timeoutMs: number, options: { strategy?: LockStrategy; pollMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!await dataFolderBusy(userData, options.strategy)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
}

/** "pid 123, ws://127.0.0.1:4100", from the lock, else from `host.json`; empty when neither says. */
export async function describeDataFolderOwner(userData: string, strategy: LockStrategy = defaultLockStrategy()): Promise<string> {
  const owner = await lockOwner(dataFolderLockPath(userData), strategy).catch(() => undefined);
  // `host.json` by hand: the supervisor's module imports this one.
  const descriptor = await readFile(join(userData, "host.json"), "utf8")
    .then((text) => JSON.parse(text) as { pid?: unknown; url?: unknown })
    .then((parsed) => (typeof parsed.pid === "number" && typeof parsed.url === "string" ? { pid: parsed.pid, url: parsed.url } : undefined))
    .catch(() => undefined);
  const pid = owner?.pid ?? descriptor?.pid;
  const url = owner?.url ?? (descriptor && (!owner || descriptor.pid === owner.pid) ? descriptor.url : undefined);
  return [pid !== undefined ? `pid ${pid}` : "", url ?? ""].filter(Boolean).join(", ");
}

/** The line a host prints when it does not start because another owns its data folder. */
export function dataFolderBusyMessage(userData: string, owner: string): string {
  return `another Tau host${owner ? ` (${owner})` : ""} owns this data folder (${userData}); this one does not start`;
}
