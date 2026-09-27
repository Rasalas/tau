import { resolve } from "node:path";
import { defaultLockStrategy, lockHeldElsewhereSync, lockOwner, tryLock, type LockOwner, type LockStrategy, type ProcessLock } from "./process-lock.js";

/** Beside the session file, so every host on the machine finds the same lock whatever its data folder. */
export function sessionLockPath(sessionFile: string): string {
  return `${sessionFile}.lock`;
}

/** What was refused because another process holds the session; the notice says so. */
export type SessionLockAction = "open" | "delete" | "restore" | "import" | "write";

/** "another Tau host (pid 1, data folder /x)", or "Pi (pid 1)" for a Pi CLI that holds it. */
export function sessionHolderText(owner: LockOwner | undefined): string {
  if (owner?.app) return `${owner.app} (pid ${owner.pid})`;
  const who = owner ? `pid ${owner.pid}${owner.dataFolder ? `, data folder ${owner.dataFolder}` : ""}` : "";
  return `another Tau host${who ? ` (${who})` : ""}`;
}

function refusal(action: SessionLockAction, owner: LockOwner | undefined): string {
  const holder = sessionHolderText(owner);
  switch (action) {
    case "open": return `This thread is open in ${holder}. It is read-only here until ${owner?.app ?? "that host"} closes it.`;
    case "delete": return `This thread is open in ${holder}; close it there before deleting it.`;
    case "restore": return `A session at this thread's place is open in ${holder}; the thread was not restored.`;
    case "import": return `The session file is open in ${holder}; nothing was imported.`;
    case "write": return `This thread is open in ${holder}; nothing was written to it.`;
  }
}

/** Another live process writes this session; this one may read it, not write it. */
export class SessionHeldElsewhereError extends Error {
  readonly sessionFile: string;
  readonly owner: LockOwner | undefined;

  constructor(sessionFile: string, owner: LockOwner | undefined, action: SessionLockAction = "open") {
    super(refusal(action, owner));
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
  async acquire(sessionFile: string, action: SessionLockAction = "open"): Promise<void> {
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
    const taking = this.take(key, action);
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

  /** Runs `work` while this host holds the session; refuses before it runs when another process does. */
  async hold<T>(sessionFile: string, action: SessionLockAction, work: () => T | Promise<T>): Promise<T> {
    await this.acquire(sessionFile, action);
    try {
      return await work();
    } finally {
      this.release(sessionFile);
    }
  }

  /** Throws when another process holds the session now; for callers that cannot wait. This host's own hold passes. */
  assertWritableSync(sessionFile: string, action: SessionLockAction = "write"): void {
    const key = resolve(sessionFile);
    if (this.held.has(key)) return;
    const probe = lockHeldElsewhereSync(sessionLockPath(key), this.options.strategy ?? defaultLockStrategy());
    if (probe.held) throw new SessionHeldElsewhereError(key, probe.owner, action);
  }

  releaseAll(): void {
    for (const { lock } of this.held.values()) lock.release();
    this.held.clear();
  }

  private async take(key: string, action: SessionLockAction): Promise<void> {
    const strategy = this.options.strategy ?? defaultLockStrategy();
    const path = sessionLockPath(key);
    const owner: LockOwner = { pid: process.pid, startedAt: this.startedAt, ...(this.options.dataFolder ? { dataFolder: this.options.dataFolder } : {}) };
    const lock = await tryLock(path, owner, strategy);
    if (!lock) throw new SessionHeldElsewhereError(key, await lockOwner(path, strategy).catch(() => undefined), action);
    this.held.set(key, { lock, refs: 1 });
  }
}
