import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLockStrategy, lockHeld, lockOwner, tryLock, type LockStrategy } from "./process-lock.js";

const MODULE = pathToFileURL(join(import.meta.dirname, "process-lock.ts")).href;
const directories: string[] = [];
const children: ChildProcess[] = [];
const strays: number[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "tau-lock-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const owner = { pid: process.pid, startedAt: "2026-09-26T00:00:00.000Z", dataFolder: "/data" };

// The platform's own mechanism, and on Unix the socket one against a socket file, so both run on every CI machine.
const strategies: Array<[string, (dir: string) => LockStrategy]> = [
  [`default (${process.platform})`, () => defaultLockStrategy()],
  ...(process.platform === "win32" ? [] : [["socket file", (dir: string) => ({ kind: "socket", address: () => join(dir, "l.sock") })] as [string, (dir: string) => LockStrategy]]),
];

describe.each(strategies)("a process lock (%s)", (_name, strategyFor) => {
  it("has one holder at a time, this process included", async () => {
    const dir = directory();
    const strategy = strategyFor(dir);
    const path = join(dir, "host.lock");
    const first = await tryLock(path, owner, strategy);

    expect(first).toBeDefined();
    expect(await tryLock(path, owner, strategy)).toBeUndefined();
    expect(await lockHeld(path, strategy)).toBe(true);

    first!.release();
    expect(await lockHeld(path, strategy)).toBe(false);
    const second = await tryLock(path, owner, strategy);
    expect(second).toBeDefined();
    second!.release();
  });

  it("tells a reader who holds it, and nothing once it is free", async () => {
    const dir = directory();
    const strategy = strategyFor(dir);
    const path = join(dir, "nested", "host.lock");
    const lock = await tryLock(path, owner, strategy);

    expect(await lockOwner(path, strategy)).toEqual(owner);
    lock!.describe({ ...owner, url: "ws://127.0.0.1:4100" });
    expect((await lockOwner(path, strategy))?.url).toBe("ws://127.0.0.1:4100");

    lock!.release();
    expect(await lockOwner(path, strategy)).toBeUndefined();
  });
});

/** A child process that takes the lock with the platform's own mechanism, optionally starts a grandchild, and says so. */
function holder(path: string, options: { grandchild?: boolean; exitAfter?: boolean } = {}): Promise<{ child: ChildProcess; grandchild?: number }> {
  const script = `
    import { spawn } from "node:child_process";
    const { tryLock } = await import(${JSON.stringify(MODULE)});
    const lock = await tryLock(${JSON.stringify(path)}, { pid: process.pid, startedAt: "now" });
    if (!lock) { console.log("busy"); process.exit(2); }
    let grandchild = 0;
    if (${Boolean(options.grandchild)}) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
      child.unref();
      grandchild = child.pid;
    }
    console.log("held " + grandchild);
    if (${Boolean(options.exitAfter)}) process.exit(0);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += String(chunk);
      const held = /held (\d+)/u.exec(output);
      if (held) {
        const grandchild = Number(held[1]) || undefined;
        if (grandchild) strays.push(grandchild);
        resolve({ child, ...(grandchild ? { grandchild } : {}) });
      } else if (output.includes("busy")) reject(new Error("the child found the lock taken"));
    });
    child.once("exit", (code) => { if (!/held/u.test(output)) reject(new Error(`the child exited with ${code}`)); });
  });
}

function exit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("a process lock across processes", () => {
  it("is refused while another process holds it, and names that process", async () => {
    const path = join(directory(), "host.lock");
    const { child } = await holder(path);

    expect(await tryLock(path, owner)).toBeUndefined();
    expect((await lockOwner(path))?.pid).toBe(child.pid);
  }, 20_000);

  it("is free once its holder is killed, without any cleanup", async () => {
    const path = join(directory(), "host.lock");
    const { child } = await holder(path);
    child.kill("SIGKILL");
    await exit(child);

    const lock = await tryLock(path, owner);
    expect(lock).toBeDefined();
    lock!.release();
  }, 20_000);

  it("is not kept alive by a process its holder started", async () => {
    const path = join(directory(), "host.lock");
    const { child, grandchild } = await holder(path, { grandchild: true, exitAfter: true });
    await exit(child);

    expect(grandchild).toBeGreaterThan(0);
    expect(() => process.kill(grandchild!, 0)).not.toThrow();
    const lock = await tryLock(path, owner);
    expect(lock).toBeDefined();
    lock!.release();
  }, 20_000);
});
