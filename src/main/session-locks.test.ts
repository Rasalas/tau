import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockHeld } from "./process-lock.js";
import { SessionHeldElsewhereError, SessionLocks, isSessionHeldElsewhere, sessionLockPath } from "./session-locks.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-session-locks-"));
  directories.push(directory);
  return join(directory, "2026-01-01T00-00-00-000Z_thread.jsonl");
}

describe("SessionLocks", () => {
  it("lets one host's runtimes share a session and keeps it until the last lets go", async () => {
    const file = sessionFile();
    const host = new SessionLocks();
    const other = new SessionLocks();
    await host.acquire(file);
    await host.acquire(file);

    host.release(file);
    await expect(other.acquire(file)).rejects.toThrow(SessionHeldElsewhereError);
    host.release(file);
    await expect(other.acquire(file)).resolves.toBeUndefined();
    other.releaseAll();
    expect(await lockHeld(sessionLockPath(file))).toBe(false);
  });

  it("names the host that holds the session", async () => {
    const file = sessionFile();
    const window = new SessionLocks({ dataFolder: "/Users/me/Library/Application Support/tau" });
    await window.acquire(file);

    const refused = await new SessionLocks({ dataFolder: "/Users/me/.tau/headless" }).acquire(file).catch((error: unknown) => error);
    expect(isSessionHeldElsewhere(refused)).toBe(true);
    expect((refused as SessionHeldElsewhereError).owner).toMatchObject({ pid: process.pid, dataFolder: "/Users/me/Library/Application Support/tau" });
    expect((refused as Error).message).toContain("(pid");
    window.releaseAll();
  });

  it("takes a session once when two opens of it race", async () => {
    const file = sessionFile();
    const host = new SessionLocks();
    await Promise.all([host.acquire(file), host.acquire(file)]);

    host.release(file);
    expect(await lockHeld(sessionLockPath(file))).toBe(true);
    host.release(file);
    expect(await lockHeld(sessionLockPath(file))).toBe(false);
  });
});
