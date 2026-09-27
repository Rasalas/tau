import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { unpackedPath } from "./packaged-app.js";
import { defaultLockStrategy, lockHeld, lockOwner, tryLock, type LockOwner, type LockStrategy, type ProcessLock } from "./process-lock.js";
import { sessionHolderText, sessionLockPath } from "./session-locks.js";

/**
 * A Pi extension for the Pi CLI, loaded with `pi -e <this file>`: Pi holds the
 * lock of the session it has open, the one Tau hosts take, and does not open
 * a session another process holds. Only type imports from Pi, so the compiled
 * file loads in any Pi; the host names it in `TAU_PI_SESSION_LOCK_EXTENSION`.
 */

export const PI_SESSION_LOCK_EXTENSION_ENV = "TAU_PI_SESSION_LOCK_EXTENSION";
/** How a Pi CLI names itself in the lock, and so in Tau's notice. */
export const PI_CLI_APP = "Pi";
/** Pi ends with this when it refused its startup session (EX_TEMPFAIL, like a busy Tau host). */
export const PI_SESSION_BUSY_EXIT_CODE = 75;

export interface PiSessionLockOptions {
  strategy?: LockStrategy;
  /** Ends a Pi that has no interactive shutdown (print, json and rpc modes). */
  exit?: (code: number) => void;
  /** Where the refusal goes once Pi's screen is gone. */
  writeError?: (text: string) => void;
  /** A holder with this pid is this Pi itself; tests name another. */
  ownPid?: number;
}

const INSTALLED = Symbol.for("tau.pi-session-locks");

export function piSessionRefusal(owner: LockOwner | undefined): string {
  return `This session is open in ${sessionHolderText(owner)}; Pi did not open it here. Close it there first, or start Pi on another session.`;
}

export function installPiSessionLocks(pi: ExtensionAPI, options: PiSessionLockOptions = {}): void {
  const strategy = options.strategy ?? defaultLockStrategy();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeError = options.writeError ?? ((text: string) => { process.stderr.write(text); });
  const startedAt = new Date().toISOString();
  const ownPid = options.ownPid ?? process.pid;
  let held: { file: string; lock: ProcessLock } | undefined;

  const release = () => {
    held?.lock.release();
    held = undefined;
  };
  /** Who else holds the session: undefined when nobody does, or this process (the extension loaded twice). */
  const otherHolder = async (file: string): Promise<{ owner: LockOwner | undefined } | undefined> => {
    const path = sessionLockPath(file);
    if (!await lockHeld(path, strategy)) return undefined;
    const owner = await lockOwner(path, strategy);
    return owner?.pid === ownPid ? undefined : { owner };
  };
  const refuse = (ctx: ExtensionContext, owner: LockOwner | undefined) => {
    const message = piSessionRefusal(owner);
    if (ctx.mode === "tui") {
      ctx.ui.notify(message, "error");
      // Printed after Pi restored the terminal, where it stays readable.
      process.once("exit", () => writeError(`${message}\n`));
      ctx.shutdown();
      return;
    }
    writeError(`${message}\n`);
    exit(PI_SESSION_BUSY_EXIT_CODE);
  };

  pi.on("session_before_switch", async (event, ctx) => {
    const target = event.targetSessionFile;
    if (!target || (held && resolve(held.file) === resolve(target))) return undefined;
    const other = await otherHolder(target);
    if (!other) return undefined;
    ctx.ui.notify(piSessionRefusal(other.owner), "error");
    return { cancel: true };
  });

  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (held && file && resolve(held.file) === resolve(file)) return;
    release();
    // --no-session: nothing on disk to share.
    if (!file) return;
    const lock = await tryLock(sessionLockPath(file), { pid: process.pid, startedAt, app: PI_CLI_APP }, strategy);
    if (lock) {
      held = { file, lock };
      return;
    }
    const other = await otherHolder(file);
    if (other) refuse(ctx, other.owner);
  });

  pi.on("session_shutdown", async () => { release(); });
}

/** Pi's entry point. Installs once per process, however often Pi loads the file. */
export default function piSessionLocks(pi: ExtensionAPI): void {
  const registry = globalThis as { [INSTALLED]?: boolean };
  if (registry[INSTALLED]) return;
  registry[INSTALLED] = true;
  installPiSessionLocks(pi);
}

/** Names the compiled file for every process this host starts, a terminal's `pi` among them. */
export function exposePiSessionLockExtension(env: NodeJS.ProcessEnv = process.env): void {
  env[PI_SESSION_LOCK_EXTENSION_ENV] = unpackedPath(fileURLToPath(import.meta.url));
}
