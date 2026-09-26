import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { basename, dirname, resolve } from "node:path";

// Kept free of relative imports and non-erasable syntax: tests load it in plain Node child processes.

/** Who holds a lock, as its holder wrote it down. */
export interface LockOwner {
  pid: number;
  startedAt: string;
  /** The holder's data folder, for a person reading the notice. */
  dataFolder?: string;
  /** Where the holder answers, once it listens. */
  url?: string;
}

/** An exclusive lock the OS holds for this process and drops when the process ends, however it ends. */
export interface ProcessLock {
  readonly path: string;
  /** Rewrites what a reader learns about the holder. */
  describe(owner: LockOwner): void;
  release(): void;
}

/**
 * `flock`: the file itself is locked (`O_EXLOCK`, BSD and macOS).
 * `socket`: a listening socket named after the file (Linux abstract namespace,
 * Windows named pipe); the file only carries the owner.
 */
export type LockStrategy = { kind: "flock" } | { kind: "socket"; address: (path: string) => string };

// BSD open(2) flags Node does not name; libuv passes them through.
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;
const BUSY_CODES = new Set(["EAGAIN", "EWOULDBLOCK"]);
/** A reader's shared lock holds the file for a moment; an acquire tries a few times before it gives up. */
const ACQUIRE_ATTEMPTS = 4;
const PROBE_TIMEOUT_MS = 1_000;

function lockKey(path: string, platform: NodeJS.Platform): string {
  let full = resolve(path);
  try { full = resolve(realpathSync.native(dirname(full)), basename(full)); } catch { /* not there yet */ }
  return createHash("sha256").update(platform === "win32" ? full.toLowerCase() : full).digest("hex").slice(0, 40);
}

export function defaultLockStrategy(platform: NodeJS.Platform = process.platform): LockStrategy {
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") return { kind: "flock" };
  if (platform === "win32") return { kind: "socket", address: (path) => `\\\\.\\pipe\\tau-lock-${lockKey(path, platform)}` };
  // Abstract namespace: no file to go stale, gone with the process.
  return { kind: "socket", address: (path) => `\0tau-lock-${lockKey(path, platform)}` };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function ownerText(owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function acquireFlock(path: string, owner: LockOwner): Promise<ProcessLock | undefined> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o600);
    } catch (error) {
      if (!BUSY_CODES.has(errorCode(error) ?? "")) throw error;
      if (attempt === ACQUIRE_ATTEMPTS) return undefined;
      await pause(20 * attempt);
      continue;
    }
    // A holder unlinks the file as it lets go; a lock on that unlinked file locks nothing.
    let current: number | undefined;
    try { current = statSync(path).ino; } catch { current = undefined; }
    if (current !== fstatSync(fd).ino) {
      closeSync(fd);
      continue;
    }
    const write = (next: LockOwner) => {
      const text = ownerText(next);
      ftruncateSync(fd, 0);
      writeSync(fd, text, 0);
    };
    write(owner);
    let held = true;
    return {
      path,
      describe: (next) => { if (held) write(next); },
      release: () => {
        if (!held) return;
        held = false;
        try { unlinkSync(path); } catch { /* gone already */ }
        closeSync(fd);
      },
    };
  }
  return undefined;
}

async function acquireSocket(path: string, owner: LockOwner, address: string): Promise<ProcessLock | undefined> {
  // A connection is only ever a probe: accepted and closed.
  const server: Server = createServer((socket) => socket.destroy());
  const listening = await new Promise<boolean>((done, fail) => {
    server.once("error", (error) => (errorCode(error) === "EADDRINUSE" ? done(false) : fail(error)));
    server.listen(address, () => done(true));
  });
  if (!listening) return undefined;
  // The lock must not keep a process alive that has nothing else to do.
  server.unref();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ownerText(owner), { mode: 0o600 });
  let held = true;
  return {
    path,
    describe: (next) => { if (held) writeFileSync(path, ownerText(next), { mode: 0o600 }); },
    release: () => {
      if (!held) return;
      held = false;
      try { unlinkSync(path); } catch { /* gone already */ }
      server.close();
    },
  };
}

/** Takes the lock named by `path`, or answers undefined while another holder has it (this process included). */
export async function tryLock(path: string, owner: LockOwner, strategy: LockStrategy = defaultLockStrategy()): Promise<ProcessLock | undefined> {
  return strategy.kind === "flock" ? acquireFlock(path, owner) : acquireSocket(path, owner, strategy.address(path));
}

/** Whether somebody holds the lock right now. A holder that hangs still holds it. */
export async function lockHeld(path: string, strategy: LockStrategy = defaultLockStrategy()): Promise<boolean> {
  if (strategy.kind === "flock") {
    try {
      closeSync(openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | O_SHLOCK));
      return false;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return false;
      if (BUSY_CODES.has(code ?? "")) return true;
      throw error;
    }
  }
  return new Promise<boolean>((done) => {
    const socket = createConnection(strategy.address(path));
    const finish = (held: boolean) => { clearTimeout(timer); socket.destroy(); done(held); };
    // A holder too busy to accept still holds the name.
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(!["ECONNREFUSED", "ENOENT"].includes(errorCode(error) ?? "")));
  });
}

/** What the current holder wrote about itself, while the lock is held. */
export async function lockOwner(path: string, strategy: LockStrategy = defaultLockStrategy()): Promise<LockOwner | undefined> {
  if (!await lockHeld(path, strategy)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      ...(typeof parsed.dataFolder === "string" ? { dataFolder: parsed.dataFolder } : {}),
      ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
    };
  } catch {
    return undefined;
  }
}
