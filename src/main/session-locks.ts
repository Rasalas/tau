import { resolve } from "node:path";
import { defaultLockStrategy, lockOwner, tryLock, type LockOwner, type LockStrategy, type ProcessLock } from "./process-lock.js";

/** Beside the session file, so every host on the machine finds the same lock whatever its data folder. */
export function sessionLockPath(sessionFile: string): string {
  return `${sessionFile}.lock`;
}

/** Another live host writes this session; this one may read it, not write it. */
export class SessionHeldElsewhereError extends Error {
  readonly sessionFile: string;
  readonly owner: LockOwner | undefined;

  constructor(sessionFile: string, owner: LockOwner | undefined) {
    const who = owner ? `pid ${owner.pid}${owner.dataFolder ? `, data folder ${owner.dataFolder}` : ""}` : "";
    super(`This thread is open in another Tau host${who ? ` (${who})` : ""}. It is read-only here until that host closes it.`);
    this.name = "SessionHeldElsewhereError";
    this.sessionFile = sessionFile;
    this.owner = owner;
  }
}

export function isSessionHeldElsewhere(error: unknown): error is SessionHeldElsewhereError {
  return error instanceof Error && error.name === "SessionHeldElsewhereError";
}

export interface SessionLocksOptions {
  /** This host's data folder, named in the notice another host shows. */
  dataFolder?: string;
  strategy?: LockStrategy;
}

/**
 * The Pi session files this host writes. Pi appends to a session without a
 * lock of its own, so two hosts on one machine — two data folders sharing
 * `~/.pi/agent/sessions` — would interleave lines in the same file. A runtime
 * opens a session only while it holds that session's lock; one lock per file,
 * shared by the runtimes of this host.
 */
export class SessionLocks {
  private readonly held = new Map<string, { lock: ProcessLock; refs: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly options: SessionLocksOptions = {}) {}

  /** Throws `SessionHeldElsewhereError` while another process holds the session. */
  async acquire(sessionFile: string): Promise<void> {
    const key = resolve(sessionFile);
    for (;;) {
      const held = this.held.get(key);
      if (held) {
        held.refs += 1;
        return;
      }
      const pending = this.pending.get(key);
      if (!pending) break;
      await pending.catch(() => undefined);
    }
    const taking = this.take(key);
    this.pending.set(key, taking);
    try {
      await taking;
    } finally {
      if (this.pending.get(key) === taking) this.pending.delete(key);
    }
  }

  release(sessionFile: string): void {
    const key = resolve(sessionFile);
    const held = this.held.get(key);
    if (!held) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    this.held.delete(key);
    held.lock.release();
  }

  releaseAll(): void {
    for (const { lock } of this.held.values()) lock.release();
    this.held.clear();
  }

  private async take(key: string): Promise<void> {
    const strategy = this.options.strategy ?? defaultLockStrategy();
    const path = sessionLockPath(key);
    const owner: LockOwner = { pid: process.pid, startedAt: this.startedAt, ...(this.options.dataFolder ? { dataFolder: this.options.dataFolder } : {}) };
    const lock = await tryLock(path, owner, strategy);
    if (!lock) throw new SessionHeldElsewhereError(key, await lockOwner(path, strategy).catch(() => undefined));
    this.held.set(key, { lock, refs: 1 });
  }
}
