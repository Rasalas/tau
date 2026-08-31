import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A small, filesystem-backed lease shared by every host and Pi bridge process. */
export interface WorkspaceCheckpointLease {
  readonly key: string;
  readonly lockPath: string;
  readonly ownerId: string;
  readonly acquiredAt: number;
  release(): Promise<void>;
}

export type WorkspaceLeaseState = "queued" | "waiting" | "acquired" | "released";

export interface WorkspaceLeaseMetadata {
  ownerId: string;
  pid: number;
  host: string;
  cwd: string;
  sessionId: string;
  turnId: string;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface WorkspaceCheckpointLeaseOptions {
  sessionId: string;
  turnId: string;
  ownerId?: string;
  signal?: AbortSignal;
  /** Maximum time to wait for a live owner. `undefined` means no deadline. */
  timeoutMs?: number;
  staleAfterMs?: number;
  pollMs?: number;
  now?(): number;
  processAlive?(pid: number): boolean;
  onState?(state: WorkspaceLeaseState): void;
}

export interface WorkspaceCheckpointLeaseManagerOptions {
  /** Override Git lookup in tests or for hosts with a specialized runner. */
  runGit?(cwd: string, args: string[]): Promise<string>;
  now?(): number;
  processAlive?(pid: number): boolean;
  staleAfterMs?: number;
  pollMs?: number;
  lockFileName?: string;
}

interface PendingAcquire {
  tail: Promise<void>;
  releaseTail(): void;
}

const DEFAULT_STALE_AFTER_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 50;

async function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (aborted(signal)) return Promise.reject(new Error("Workspace checkpoint lease acquisition was aborted."));
  return new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Workspace checkpoint lease acquisition was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Workspace checkpoint lease acquisition was aborted."));
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectWait(new Error("Workspace checkpoint lease acquisition was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolveWait(value); },
      (error) => { signal.removeEventListener("abort", onAbort); rejectWait(error); },
    );
  });
}

async function canonicalGitCommonDir(
  cwd: string,
  runGit: (cwd: string, args: string[]) => Promise<string>,
): Promise<string | undefined> {
  try {
    const output = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const candidate = output.trim();
    if (candidate) return await realpath(resolve(cwd, candidate));
  } catch {
    // Plain folders still need a per-workspace lease. Their canonical path is
    // the real directory, while repositories share the Git common directory.
  }
  return undefined;
}

function leasePath(commonDir: string, lockFileName: string): string {
  // A repository's common dir is already private to its Git metadata. Plain
  // folders use a hashed temp namespace so no marker is written into user data.
  return join(commonDir, lockFileName);
}

function metadataFromFile(value: string): WorkspaceLeaseMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceLeaseMetadata>;
    if (typeof parsed.ownerId !== "string" || typeof parsed.pid !== "number" || typeof parsed.host !== "string"
      || typeof parsed.cwd !== "string" || typeof parsed.sessionId !== "string" || typeof parsed.turnId !== "string"
      || typeof parsed.acquiredAt !== "number" || typeof parsed.heartbeatAt !== "number") return undefined;
    return parsed as WorkspaceLeaseMetadata;
  } catch {
    return undefined;
  }
}

function isStale(
  metadata: WorkspaceLeaseMetadata | undefined,
  now: number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!metadata || !Number.isFinite(metadata.heartbeatAt)) return true;
  if (now - metadata.heartbeatAt < staleAfterMs) return false;
  // A PID is meaningful only on the same host. A crashed remote process leaves
  // no reliable liveness probe, so its heartbeat age is the recovery signal.
  return metadata.host !== hostname() || !isAlive(metadata.pid);
}

async function isStaleMarker(
  lockPath: string,
  metadata: WorkspaceLeaseMetadata | undefined,
  now: number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (metadata) return isStale(metadata, now, staleAfterMs, isAlive);
  // A freshly-created marker is briefly empty while its owner writes the JSON
  // metadata. Do not delete that live lock based on a transient parse race;
  // malformed markers become recoverable once their mtime is stale.
  const marker = await stat(lockPath).catch(() => undefined);
  return Boolean(marker && now - marker.mtimeMs >= staleAfterMs);
}

/**
 * Serialises workspace mutation windows without touching the user's index or
 * worktree. Atomic `open(..., "wx")` is the inter-process boundary; the local
 * FIFO tail avoids starvation between runtimes in one host process.
 */
export class WorkspaceCheckpointLeaseManager {
  private readonly queued = new Map<string, PendingAcquire>();
  private readonly runGit: (cwd: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly staleAfterMs: number;
  private readonly pollMs: number;
  private readonly lockFileName: string;

  constructor(options: WorkspaceCheckpointLeaseManagerOptions = {}) {
    this.runGit = options.runGit ?? defaultRunGit;
    this.now = options.now ?? Date.now;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.lockFileName = options.lockFileName ?? "tau-turn-checkpoint.lock";
  }

  async canonicalKey(cwd: string): Promise<string> {
    const commonDir = await canonicalGitCommonDir(cwd, this.runGit);
    if (commonDir) return commonDir;
    // Plain folders have no safe metadata directory in which to leave a
    // marker. Hash their canonical path into a private temp namespace instead;
    // symlinked spellings of the same folder therefore share one lease too.
    const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
    const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 32);
    return join(tmpdir(), "tau-workspace-leases", digest);
  }

  async acquire(cwd: string, options: WorkspaceCheckpointLeaseOptions): Promise<WorkspaceCheckpointLease> {
    const key = await this.canonicalKey(cwd);
    options.onState?.("queued");
    const previous = this.queued.get(key);
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolveTail) => { releaseTail = resolveTail; });
    const pending: PendingAcquire = { tail: previous ? previous.tail.then(() => undefined) : Promise.resolve(), releaseTail };
    this.queued.set(key, pending);
    let handedOff = false;
    try {
      await waitForAbort(pending.tail, options.signal);
      if (aborted(options.signal)) throw new Error("Workspace checkpoint lease acquisition was aborted.");
      const acquired = await this.acquireFile(key, cwd, options);
      handedOff = true;
      const release = acquired.release;
      return {
        ...acquired,
        release: async () => {
          try {
            await release();
          } finally {
            if (this.queued.get(key) === pending) this.queued.delete(key);
            releaseTail();
          }
        },
      };
    } finally {
      if (!handedOff) {
        // An aborted waiter must not release the local FIFO slot while its
        // predecessor still owns the checkout. Keep the pending node linked so
        // a later turn cannot bypass the live owner, then retire it once the
        // predecessor's tail resolves.
        pending.tail.then(
          () => {
            if (this.queued.get(key) === pending) this.queued.delete(key);
            releaseTail();
          },
          () => {
            if (this.queued.get(key) === pending) this.queued.delete(key);
            releaseTail();
          },
        );
      }
    }
  }

  private async acquireFile(
    key: string,
    cwd: string,
    options: WorkspaceCheckpointLeaseOptions,
  ): Promise<WorkspaceCheckpointLease> {
    const lockPath = leasePath(key, this.lockFileName);
    await mkdir(dirname(lockPath), { recursive: true });
    const now = options.now ?? this.now;
    const staleAfterMs = options.staleAfterMs ?? this.staleAfterMs;
    const pollMs = options.pollMs ?? this.pollMs;
    const isAlive = options.processAlive ?? this.processAlive;
    const ownerId = options.ownerId ?? randomUUID();
    const startedWaitingAt = now();
    options.onState?.("waiting");
    for (;;) {
      if (aborted(options.signal)) throw new Error("Workspace checkpoint lease acquisition was aborted.");
      if (options.timeoutMs !== undefined && now() - startedWaitingAt >= options.timeoutMs) {
        throw new Error("Timed out waiting for the workspace checkpoint lease.");
      }
      const acquiredAt = now();
      const metadata: WorkspaceLeaseMetadata = {
        ownerId,
        pid: process.pid,
        host: hostname(),
        cwd,
        sessionId: options.sessionId,
        turnId: options.turnId,
        acquiredAt,
        heartbeatAt: acquiredAt,
      };
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        options.onState?.("acquired");
        let released = false;
        let heartbeatBusy = false;
        const refreshHeartbeat = async () => {
          if (released || heartbeatBusy) return;
          heartbeatBusy = true;
          try {
            // Never overwrite a marker that a stale-recovery process has
            // already replaced with another owner's lock. Opening the inode
            // first also means an unlink/recreate race only updates the old
            // inode, never the new owner's marker.
            const heartbeatHandle = await open(lockPath, "r+");
            try {
              const current = metadataFromFile(await heartbeatHandle.readFile("utf8"));
              if (current?.ownerId !== ownerId) {
                released = true;
                return;
              }
              await heartbeatHandle.truncate(0);
              await heartbeatHandle.writeFile(`${JSON.stringify({ ...metadata, heartbeatAt: now() })}\n`, "utf8");
            } finally {
              await heartbeatHandle.close();
            }
          } catch {
            // Release/recovery may remove the marker while this refresh is in
            // flight. The ownership check above keeps that race harmless.
          } finally {
            heartbeatBusy = false;
          }
        };
        const heartbeat = setInterval(() => { void refreshHeartbeat(); }, Math.max(1_000, Math.floor(staleAfterMs / 3)));
        heartbeat.unref?.();
        return {
          key,
          lockPath,
          ownerId,
          acquiredAt,
          release: async () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            try {
              const current = metadataFromFile(await readFile(lockPath, "utf8"));
              if (current?.ownerId === ownerId) await rm(lockPath, { force: true });
            } catch {
              // A stale-recovery process may have removed the marker already.
            }
            options.onState?.("released");
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: WorkspaceLeaseMetadata | undefined;
        try { existing = metadataFromFile(await readFile(lockPath, "utf8")); } catch { /* raced with release */ }
        if (await isStaleMarker(lockPath, existing, now(), staleAfterMs, isAlive)) {
          // The content check above makes stale recovery conservative. The
          // create-with-excl retry below is the final ownership arbiter.
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        await sleep(pollMs, options.signal);
      }
    }
  }
}
