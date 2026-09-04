import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitExecutable } from "./shell-environment.js";

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

interface RecoveryClaim extends WorkspaceLeaseMetadata {
  targetOwnerId: string;
}

interface MutationGuard {
  readonly path: string;
  readonly ownerId: string;
  release(): Promise<void>;
}

const DEFAULT_STALE_AFTER_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 50;

/**
 * Leases stay under the OS temp dir rather than Electron's userData: the Pi
 * bridge processes that also take this lease run outside Electron and have
 * no userData path, and leases are keyed by checkout identity, not by app
 * install, so a shared, machine-wide root is what makes them findable across
 * processes. The root and every marker file it holds are created 0o700/0o600
 * so other local users cannot read or race lease metadata.
 */
function leaseRoot(): string {
  return join(tmpdir(), "tau-workspace-leases");
}

async function defaultRunGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable(), ["-c", "core.quotePath=false", ...args], {
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

async function canonicalGitCheckout(
  cwd: string,
  runGit: (cwd: string, args: string[]) => Promise<string>,
): Promise<string | undefined> {
  try {
    // A linked worktree intentionally has a different git-dir and checkout
    // root while sharing the common object store.  The pair, rather than the
    // common dir, is the ownership identity: turns in sibling worktrees may
    // run concurrently, while two runtimes attached to one checkout queue.
    const bareOutput = await runGit(cwd, ["rev-parse", "--is-bare-repository"]);
    if (bareOutput.trim() === "true") {
      const gitDir = (await runGit(cwd, ["rev-parse", "--git-dir"])).trim();
      // Bare repositories have no checkout to snapshot. They still get a
      // stable lease identity so callers can report capability-unavailable
      // without colliding with an unrelated plain folder.
      return gitDir ? `bare\0${await realpath(resolve(cwd, gitDir))}` : undefined;
    }
    const [rootOutput, gitDirOutput] = await Promise.all([
      runGit(cwd, ["rev-parse", "--show-toplevel"]),
      runGit(cwd, ["rev-parse", "--git-dir"]),
    ]);
    const gitDir = gitDirOutput.trim();
    if (!gitDir) return undefined;
    const root = rootOutput.trim();
    if (!root) return undefined;
    const [canonicalRoot, canonicalGitDir] = await Promise.all([
      realpath(resolve(cwd, root)),
      realpath(resolve(cwd, gitDir)),
    ]);
    return `checkout\0${canonicalRoot}\0${canonicalGitDir}`;
  } catch {
    // Plain folders still need a per-workspace lease. Their canonical path is
    // the real directory and is hashed below into a private namespace.
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

function recoveryFromFile(value: string): RecoveryClaim | undefined {
  const item = metadataFromFile(value) as RecoveryClaim | undefined;
  if (!item || typeof item.targetOwnerId !== "string" || !item.targetOwnerId) return undefined;
  return item;
}

function isStale(
  metadata: WorkspaceLeaseMetadata | undefined,
  now: number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!metadata || !Number.isFinite(metadata.heartbeatAt)) return true;
  // A PID is meaningful only on the same host, and there it is the better
  // signal: an owner that died without releasing must not hold the queue for a
  // heartbeat window. A crashed remote process leaves no liveness probe, so
  // only its heartbeat age can recover it.
  if (metadata.host === hostname()) return !isAlive(metadata.pid);
  return now - metadata.heartbeatAt >= staleAfterMs;
}

export interface LiveWorkspaceLeaseOptions {
  now?(): number;
  staleAfterMs?: number;
  processAlive?(pid: number): boolean;
  lockFileName?: string;
}

/**
 * Returns active writers visible to this process.  Git refs are shared by
 * linked worktrees even though their checkout leases are intentionally
 * independent, so maintenance must prove that an unknown session is not
 * currently publishing from a sibling checkout before deleting its refs.
 */
export async function listLiveWorkspaceLeaseSessions(
  options: LiveWorkspaceLeaseOptions = {},
): Promise<readonly WorkspaceLeaseMetadata[]> {
  const root = leaseRoot();
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isAlive = options.processAlive ?? defaultProcessAlive;
  const lockFileName = options.lockFileName ?? "tau-turn-checkpoint.lock";
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const owners: WorkspaceLeaseMetadata[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const lockPath = join(root, directory.name, lockFileName);
    const metadata = metadataFromFile(await readFile(lockPath, "utf8").catch(() => ""));
    if (metadata && !isStale(metadata, now(), staleAfterMs, isAlive)) owners.push(metadata);
  }
  return owners;
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

function recoveryPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function mutationGuardPath(lockPath: string): string {
  return `${lockPath}.guard`;
}

function mutationGuardTokenPath(path: string, ownerId: string): string {
  return join(path, `${ownerId}.json`);
}

interface FilesystemLeaseTicket {
  path: string;
  sequence: number;
  metadata?: WorkspaceLeaseMetadata;
}

const TICKET_FILE_PATTERN = /^(\d{20})-([0-9a-f-]+)\.json$/iu;

function ticketQueuePath(key: string): string {
  return join(key, "tickets");
}

function ticketSequencePath(queuePath: string): string {
  return join(queuePath, "sequence");
}

async function readTicketEntries(queuePath: string): Promise<FilesystemLeaseTicket[]> {
  const entries = await readdir(queuePath, { withFileTypes: true }).catch(() => []);
  const tickets: FilesystemLeaseTicket[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = TICKET_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const path = join(queuePath, entry.name);
    const metadata = metadataFromFile(await readFile(path, "utf8").catch(() => ""));
    // Include an in-flight (temporarily empty) ticket in ordering. Ignoring it
    // would let a later process pass while the first owner is still writing.
    tickets.push({ path, sequence: Number(match[1]), metadata });
  }
  return tickets.sort((left, right) => left.sequence - right.sequence || left.path.localeCompare(right.path));
}

async function cleanupStaleTickets(
  queuePath: string,
  now: () => number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
  ownTicketPath?: string,
): Promise<void> {
  const entries = await readdir(queuePath, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile() && TICKET_FILE_PATTERN.test(entry.name)).map(async (entry) => {
    const path = join(queuePath, entry.name);
    // A waiter is by definition alive, whatever a liveness probe reports about
    // it. Reclaiming its own ticket would abort the wait it is performing.
    if (path === ownTicketPath) return;
    const metadata = metadataFromFile(await readFile(path, "utf8").catch(() => ""));
    const stale = metadata
      ? isStale(metadata, now(), staleAfterMs, isAlive)
      : await stat(path).then((item) => now() - item.mtimeMs >= staleAfterMs).catch(() => false);
    // Tickets are immutable create-if-absent files. Removing this exact path
    // cannot touch a later owner's generation, and a live same-host process
    // is protected by the PID check above.
    if (stale) await rm(path, { force: true }).catch(() => undefined);
  }));
}

async function writeSequenceCounter(path: string, value: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${value}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function createFilesystemTicket(
  key: string,
  cwd: string,
  options: WorkspaceCheckpointLeaseOptions,
  ownerId: string,
  now: () => number,
  staleAfterMs: number,
  pollMs: number,
  isAlive: (pid: number) => boolean,
): Promise<FilesystemLeaseTicket> {
  const queuePath = ticketQueuePath(key);
  await mkdir(queuePath, { recursive: true, mode: 0o700 });
  const sequencePath = ticketSequencePath(queuePath);
  const guard = await acquireMutationGuard(
    sequencePath,
    cwd,
    options.sessionId,
    options.turnId,
    now,
    staleAfterMs,
    pollMs,
    isAlive,
  );
  try {
    const counter = Number.parseInt(await readFile(sequencePath, "utf8").catch(() => "0"), 10);
    const existing = await readTicketEntries(queuePath);
    const largestTicket = existing.reduce((largest, ticket) => Math.max(largest, ticket.sequence), 0);
    const sequence = Math.max(Number.isSafeInteger(counter) ? counter : 0, largestTicket) + 1;
    await writeSequenceCounter(sequencePath, sequence);
    const metadata: WorkspaceLeaseMetadata = {
      ownerId,
      pid: process.pid,
      host: hostname(),
      cwd,
      sessionId: options.sessionId,
      turnId: options.turnId,
      acquiredAt: now(),
      heartbeatAt: now(),
    };
    const path = join(queuePath, `${String(sequence).padStart(20, "0")}-${randomUUID()}.json`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return { path, sequence, metadata };
  } finally {
    await guard.release();
  }
}

async function waitForFilesystemTicket(
  ticket: FilesystemLeaseTicket,
  options: WorkspaceCheckpointLeaseOptions,
  now: () => number,
  staleAfterMs: number,
  pollMs: number,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  const queuePath = dirname(ticket.path);
  const startedWaitingAt = now();
  let reportedWaiting = false;
  for (;;) {
    if (aborted(options.signal)) throw new Error("Workspace checkpoint lease acquisition was aborted.");
    if (options.timeoutMs !== undefined && now() - startedWaitingAt >= options.timeoutMs) {
      throw new Error("Timed out waiting for the workspace checkpoint lease.");
    }
    await cleanupStaleTickets(queuePath, now, staleAfterMs, isAlive, ticket.path);
    const tickets = await readTicketEntries(queuePath);
    if (!tickets.some((candidate) => candidate.path === ticket.path)) {
      throw new Error("Workspace checkpoint lease ticket was reclaimed before admission.");
    }
    const first = tickets[0];
    if (first?.path === ticket.path) return;
    if (!reportedWaiting) {
      reportedWaiting = true;
      options.onState?.("waiting");
    }
    await sleep(pollMs, options.signal);
  }
}

async function removeFilesystemTicket(ticket: FilesystemLeaseTicket | undefined): Promise<void> {
  if (ticket) await rm(ticket.path, { force: true }).catch(() => undefined);
}

/**
 * Serializes every mutation of the active marker.  The guard is a directory
 * generation, not a read/remove/recreate flag: reclaiming a stale generation
 * first renames that exact directory, and a normal release removes only its
 * owner-specific token before attempting a non-recursive rmdir.  A late
 * release therefore cannot remove a newly-created generation at the same
 * pathname.
 */
async function acquireMutationGuard(
  lockPath: string,
  cwd: string,
  sessionId: string,
  turnId: string,
  now: () => number,
  staleAfterMs: number,
  pollMs: number,
  isAlive: (pid: number) => boolean,
): Promise<MutationGuard> {
  const path = mutationGuardPath(lockPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const ownerId = randomUUID();
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      const tokenPath = mutationGuardTokenPath(path, ownerId);
      const metadata: WorkspaceLeaseMetadata = {
        ownerId,
        pid: process.pid,
        host: hostname(),
        cwd,
        sessionId,
        turnId,
        acquiredAt: now(),
        heartbeatAt: now(),
      };
      try {
        await writeGuardToken(tokenPath, metadata);
      } catch (error) {
        await rmdir(path).catch(() => undefined);
        throw error;
      }
      let released = false;
      return {
        path,
        ownerId,
        release: async () => {
          if (released) return;
          released = true;
          // The owner-specific token is the compare-and-delete boundary. A
          // later generation has a different token, even if the directory
          // pathname has already been reused after stale recovery.
          await rm(tokenPath, { force: true }).catch(() => undefined);
          // Never recursively remove a directory here: a new generation with
          // a different token must make this fail rather than being deleted.
          await rmdir(path).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readGuardMetadata(path);
      const marker = await stat(path).catch(() => undefined);
      const stale = existing
        ? isStale(existing, now(), staleAfterMs, isAlive)
        : Boolean(marker && now() - marker.mtimeMs >= staleAfterMs);
      if (stale) {
        const stalePath = `${path}.stale.${randomUUID()}`;
        await rename(path, stalePath)
          .then(() => rm(stalePath, { recursive: true, force: true }))
          .catch(() => undefined);
        continue;
      }
      await sleep(pollMs);
    }
  }
}

async function writeGuardToken(path: string, metadata: WorkspaceLeaseMetadata): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeFileOwnedMarker(path: string, metadata: WorkspaceLeaseMetadata): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function readGuardMetadata(path: string): Promise<WorkspaceLeaseMetadata | undefined> {
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const metadata = metadataFromFile(await readFile(join(path, entry), "utf8").catch(() => ""));
    if (metadata) return metadata;
  }
  return undefined;
}

/**
 * A recovery claim is an atomic, stable-path generation.  While it exists no
 * new owner may acquire the active marker.  This closes the classic
 * read-stale → unlink → create race: only the claimant may quarantine the
 * exact active inode, and a releasing owner checks its token before touching
 * the path.  The quarantine rename is also useful when inspecting a crash.
 */
async function claimStaleMarker(
  lockPath: string,
  existing: WorkspaceLeaseMetadata | undefined,
  now: () => number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  const claimPath = recoveryPath(lockPath);
  const claimOwnerId = randomUUID();
  const targetOwnerId = existing?.ownerId ?? "unknown";
  const claim: RecoveryClaim = {
    ownerId: claimOwnerId,
    targetOwnerId,
    pid: process.pid,
    host: hostname(),
    cwd: existing?.cwd ?? "",
    sessionId: existing?.sessionId ?? "",
    turnId: existing?.turnId ?? "",
    acquiredAt: now(),
    heartbeatAt: now(),
  };
  let handle;
  try {
    handle = await open(claimPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A crashed recovery claimant must not permanently strand the checkout.
    // Quarantine its generation atomically; a concurrent claimant either wins
    // the rename or observes ENOENT and retries from the active marker.
    const currentClaim = recoveryFromFile(await readFile(claimPath, "utf8").catch(() => ""));
    if (currentClaim && !isStale(currentClaim, now(), staleAfterMs, isAlive)) return false;
    if (!currentClaim) {
      const marker = await stat(claimPath).catch(() => undefined);
      if (!marker || now() - marker.mtimeMs < staleAfterMs) return false;
    }
    const staleClaimPath = `${claimPath}.stale.${randomUUID()}`;
    await rename(claimPath, staleClaimPath).then(() => rm(staleClaimPath, { force: true })).catch(() => undefined);
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    // Re-read after the atomic claim. If the old owner renewed or released,
    // never quarantine a different generation.
    const current = metadataFromFile(await readFile(lockPath, "utf8").catch(() => ""));
    if (!current) {
      const marker = await stat(lockPath).catch(() => undefined);
      if (!marker || now() - marker.mtimeMs < staleAfterMs) return false;
    } else if (current.ownerId !== targetOwnerId || !isStale(current, now(), staleAfterMs, isAlive)) {
      return false;
    }
    const quarantined = `${lockPath}.stale.${claimOwnerId}`;
    await rename(lockPath, quarantined);
    await rm(quarantined, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return true;
  } finally {
    // Release only this claimant's generation. A new claimant cannot acquire
    // the path until this finally runs, and an old owner never owns this file.
    const currentClaim = recoveryFromFile(await readFile(claimPath, "utf8").catch(() => ""));
    if (currentClaim?.ownerId === claimOwnerId) await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Serialises workspace mutation windows without touching the user's index or
 * worktree. Atomic ticket creation and a filesystem sequence counter provide
 * FIFO admission across independent host and bridge processes.
 */
export class WorkspaceCheckpointLeaseManager {
  private readonly canonicalKeys = new Map<string, Promise<string>>();
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
    const lookupKey = resolve(cwd);
    const cached = this.canonicalKeys.get(lookupKey);
    if (cached) return cached;
    // Canonical identity is stable for the life of a runtime. Caching it also
    // keeps the lease path lookup from spawning three Git processes for every
    // turn in a busy checkout.
    const pending = (async () => {
      const checkout = await canonicalGitCheckout(cwd, this.runGit);
      if (checkout) {
        const digest = createHash("sha256").update(checkout).digest("hex").slice(0, 32);
        return join(leaseRoot(), digest);
      }
      // Plain folders have no safe metadata directory in which to leave a
      // marker. Hash their canonical path into a private temp namespace
      // instead; symlinked spellings of the same folder share one lease too.
      const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
      const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 32);
      return join(leaseRoot(), digest);
    })();
    this.canonicalKeys.set(lookupKey, pending);
    return pending;
  }

  async acquire(cwd: string, options: WorkspaceCheckpointLeaseOptions): Promise<WorkspaceCheckpointLease> {
    const key = await this.canonicalKey(cwd);
    options.onState?.("queued");
    const now = options.now ?? this.now;
    const staleAfterMs = options.staleAfterMs ?? this.staleAfterMs;
    const pollMs = options.pollMs ?? this.pollMs;
    const isAlive = options.processAlive ?? this.processAlive;
    const ownerId = options.ownerId ?? randomUUID();
    const ticket = await createFilesystemTicket(
      key,
      cwd,
      options,
      ownerId,
      now,
      staleAfterMs,
      pollMs,
      isAlive,
    );
    let handedOff = false;
    try {
      await waitForFilesystemTicket(ticket, options, now, staleAfterMs, pollMs, isAlive);
      if (aborted(options.signal)) throw new Error("Workspace checkpoint lease acquisition was aborted.");
      const acquired = await this.acquireFile(key, cwd, { ...options, ownerId });
      handedOff = true;
      await removeFilesystemTicket(ticket);
      const release = acquired.release;
      return {
        ...acquired,
        release: async () => {
          try {
            await release();
          } finally {
            await removeFilesystemTicket(ticket);
          }
        },
      };
    } finally {
      if (!handedOff) {
        // An aborted or failed waiter owns only this immutable ticket. Remove
        // exactly that file immediately; later tickets remain ordered and may
        // proceed without depending on a local manager instance.
        await removeFilesystemTicket(ticket);
      }
    }
  }

  private async acquireFile(
    key: string,
    cwd: string,
    options: WorkspaceCheckpointLeaseOptions,
  ): Promise<WorkspaceCheckpointLease> {
    const lockPath = leasePath(key, this.lockFileName);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
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
      const guard = await acquireMutationGuard(
        lockPath,
        cwd,
        options.sessionId,
        options.turnId,
        now,
        staleAfterMs,
        pollMs,
        isAlive,
      );
      let shouldWait = false;
      try {
        // A recovery generation blocks new owners until its claimant either
        // quarantines the stale marker or gives up. This is the inter-process
        // half of the FIFO/ownership protocol.
        const claim = await readFile(recoveryPath(lockPath), "utf8").catch(() => "");
        if (claim) {
          const recovery = recoveryFromFile(claim);
          if (!recovery || !isStale(recovery, now(), staleAfterMs, isAlive)) {
            shouldWait = true;
          } else {
            const staleClaimPath = `${recoveryPath(lockPath)}.stale.${randomUUID()}`;
            await rename(recoveryPath(lockPath), staleClaimPath)
              .then(() => rm(staleClaimPath, { force: true }))
              .catch(() => undefined);
          }
        }
        if (!shouldWait) {
          const existing = metadataFromFile(await readFile(lockPath, "utf8").catch(() => ""));
          if (existing) {
            if (await isStaleMarker(lockPath, existing, now(), staleAfterMs, isAlive)) {
              // Recovery is won by one atomic claim. The claimant quarantines
              // the exact stale inode while this guard excludes new owners.
              await claimStaleMarker(lockPath, existing, now, staleAfterMs, isAlive);
            } else {
              shouldWait = true;
            }
          } else if (await stat(lockPath).then(() => true).catch(() => false)) {
            if (await isStaleMarker(lockPath, undefined, now(), staleAfterMs, isAlive)) {
              await claimStaleMarker(lockPath, undefined, now, staleAfterMs, isAlive);
            } else {
              shouldWait = true;
            }
          } else {
            const handle = await open(lockPath, "wx", 0o600);
            try {
              await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
            } catch (error) {
              await rm(lockPath, { force: true }).catch(() => undefined);
              throw error;
            } finally {
              await handle.close();
            }
            options.onState?.("acquired");
            let released = false;
            let heartbeatBusy = false;
            const refreshHeartbeat = async () => {
              if (released || heartbeatBusy) return;
              heartbeatBusy = true;
              let heartbeatGuard: MutationGuard | undefined;
              try {
                heartbeatGuard = await acquireMutationGuard(
                  lockPath,
                  cwd,
                  options.sessionId,
                  options.turnId,
                  now,
                  staleAfterMs,
                  pollMs,
                  isAlive,
                );
                if (released) return;
                // All active-marker writes share the guard. The owner check and
                // write are therefore one serialized mutation window.
                const current = metadataFromFile(await readFile(lockPath, "utf8").catch(() => ""));
                if (current?.ownerId !== ownerId) {
                  released = true;
                  return;
                }
                await writeFileOwnedMarker(lockPath, { ...metadata, heartbeatAt: now() });
              } catch {
                // Release/recovery may remove the marker while this refresh is
                // in flight. The serialized ownership check keeps it harmless.
              } finally {
                await heartbeatGuard?.release();
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
                let releaseGuard: MutationGuard | undefined;
                try {
                  releaseGuard = await acquireMutationGuard(
                    lockPath,
                    cwd,
                    options.sessionId,
                    options.turnId,
                    now,
                    staleAfterMs,
                    pollMs,
                    isAlive,
                  );
                  const current = metadataFromFile(await readFile(lockPath, "utf8").catch(() => ""));
                  if (current?.ownerId === ownerId) await rm(lockPath, { force: true });
                } catch {
                  // A stale-recovery process may have removed this generation.
                } finally {
                  await releaseGuard?.release();
                }
                options.onState?.("released");
              },
            };
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // An older bridge/runtime may still be using the marker without the
        // guard. Re-read it on the next guarded iteration rather than removing
        // anything based on a stale path check.
        shouldWait = true;
      } finally {
        await guard.release();
      }
      if (shouldWait) await sleep(pollMs, options.signal);
    }
  }
}
