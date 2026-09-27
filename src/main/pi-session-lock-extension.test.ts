import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { lockHeld, lockOwner } from "./process-lock.js";
import { installPiSessionLocks, PI_SESSION_BUSY_EXIT_CODE } from "./pi-session-lock-extension.js";
import { SessionLocks, sessionLockPath } from "./session-locks.js";

const directories: string[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sessionFile(name = "thread"): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-pi-locks-"));
  directories.push(directory);
  return join(directory, `2026-09-27T00-00-00-000Z_${name}.jsonl`);
}

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

/** The slice of Pi's extension API the lock uses, with a context per call. */
function fakePi(options: { mode?: "tui" | "print" } = {}) {
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  let shutdowns = 0;
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  const context = (file: string | undefined) => ({
    mode: options.mode ?? "tui",
    sessionManager: { getSessionFile: () => file },
    ui: { notify: (message: string) => { notices.push(message); } },
    shutdown: () => { shutdowns += 1; },
  });
  // Another pid: the Tau host in this test process stands for another process.
  installPiSessionLocks(pi, { ownPid: -1, exit: (code) => { exits.push(code); }, writeError: (text) => { errors.push(text); } });
  return {
    notices,
    errors,
    exits,
    shutdowns: () => shutdowns,
    start: (file: string | undefined) => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context(file)),
    beforeSwitch: (target: string | undefined) => handlers.get("session_before_switch")!({ type: "session_before_switch", reason: "resume", targetSessionFile: target }, context(undefined)),
    shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(undefined)),
  };
}

async function tauHostHolding(file: string): Promise<SessionLocks> {
  const host = new SessionLocks({ dataFolder: "/tmp/tau-a" });
  await host.acquire(file);
  releases.push(() => host.releaseAll());
  return host;
}

describe("the Pi CLI's session lock extension", () => {
  it("holds the session Pi has open, under Pi's name, until Pi leaves it", async () => {
    const file = sessionFile();
    const pi = fakePi();
    await pi.start(file);

    expect(await lockOwner(sessionLockPath(file))).toMatchObject({ pid: process.pid, app: "Pi" });
    const refused = await new SessionLocks().acquire(file).catch((error: unknown) => error as Error);
    expect(refused?.message).toBe(`This thread is open in Pi (pid ${process.pid}). It is read-only here until Pi closes it.`);

    await pi.shutdown();
    expect(await lockHeld(sessionLockPath(file))).toBe(false);
  });

  it("moves the lock along when Pi switches sessions, and holds nothing without a file", async () => {
    const first = sessionFile("first");
    const second = sessionFile("second");
    const pi = fakePi();
    await pi.start(first);
    await pi.start(second);

    expect(await lockHeld(sessionLockPath(first))).toBe(false);
    expect(await lockHeld(sessionLockPath(second))).toBe(true);
    await pi.start(undefined);
    expect(await lockHeld(sessionLockPath(second))).toBe(false);
  });

  it("closes Pi's screen with the holder named when a Tau host has the session", async () => {
    const file = sessionFile();
    await tauHostHolding(file);
    const pi = fakePi({ mode: "tui" });
    await pi.start(file);

    expect(pi.shutdowns()).toBe(1);
    expect(pi.notices[0]).toBe(`This session is open in another Tau host (pid ${process.pid}, data folder /tmp/tau-a); Pi did not open it here. Close it there first, or start Pi on another session.`);
    expect(pi.exits).toEqual([]);
  });

  it("ends a print-mode Pi before its prompt, with the notice on stderr", async () => {
    const file = sessionFile();
    await tauHostHolding(file);
    const pi = fakePi({ mode: "print" });
    await pi.start(file);

    expect(pi.exits).toEqual([PI_SESSION_BUSY_EXIT_CODE]);
    expect(pi.errors.join("")).toContain("open in another Tau host");
  });

  it("cancels a switch to a session another process holds and lets any other through", async () => {
    const held = sessionFile("held");
    const free = sessionFile("free");
    await tauHostHolding(held);
    const pi = fakePi();

    expect(await pi.beforeSwitch(held)).toEqual({ cancel: true });
    expect(pi.notices[0]).toContain("data folder /tmp/tau-a");
    expect(await pi.beforeSwitch(free)).toBeUndefined();
    expect(await pi.beforeSwitch(undefined)).toBeUndefined();
  });
});
