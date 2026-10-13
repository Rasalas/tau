import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLockPath } from "./check.mjs";

const runner = new URL("./check.mjs", import.meta.url).href;
let directory;
let main;
let worktree;
let entry;
let children;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
}

beforeEach(() => {
  children = [];
  directory = realpathSync(mkdtempSync(join(tmpdir(), "tau-checks-")));
  main = join(directory, "main");
  worktree = join(directory, "linked worktree");
  mkdirSync(main);
  git(main, "init");
  git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  git(main, "worktree", "add", "--detach", worktree, "HEAD");
  entry = join(directory, "check-fixture.mjs");
  writeFileSync(entry, `
    process.send({ args: process.argv.slice(2), cwd: process.cwd() });
    process.on("message", ({ code }) => process.exit(code));
  `);
});

afterEach(async () => {
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
  }
  await Promise.all(children.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

function start(cwd, args = [], target = entry) {
  const program = `import { runCheck } from ${JSON.stringify(runner)}; await runCheck(process.argv[1], process.argv.slice(2));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, target, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const state = { process: child, started: false, stderr: "" };
  state.ready = new Promise((done) => child.once("message", (message) => {
    state.started = true;
    done(message);
  }));
  state.waiting = new Promise((done) => child.stderr.on("data", (data) => {
    state.stderr += data;
    if (state.stderr.includes("[check] Waiting for")) done();
  }));
  state.exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  children.push(state);
  return state;
}

describe("checks across worktrees", () => {
  it("waits before loading a second check and preserves its arguments, cwd and exit code", async () => {
    expect(checkLockPath(main)).toBe(checkLockPath(worktree));
    const first = start(main);
    await first.ready;
    const second = start(worktree, ["file with spaces.ts", "--noEmit"]);
    await second.waiting;
    expect(second.started).toBe(false);
    expect(second.stderr).toContain(String(first.process.pid));
    first.process.send({ code: 7 });
    expect(await first.exited).toEqual({ code: 7, signal: null });
    expect(await second.ready).toEqual({ args: ["file with spaces.ts", "--noEmit"], cwd: worktree });
    second.process.send({ code: 0 });
    expect(await second.exited).toEqual({ code: 0, signal: null });
  });

  it("lets a waiter cancel without releasing the active check's slot", async () => {
    const first = start(main);
    await first.ready;
    const cancelled = start(worktree);
    await cancelled.waiting;
    cancelled.process.kill("SIGTERM");
    await cancelled.exited;
    expect(cancelled.started).toBe(false);
    const next = start(worktree);
    await next.waiting;
    expect(next.started).toBe(false);
    first.process.send({ code: 0 });
    await first.exited;
    await next.ready;
    next.process.send({ code: 0 });
    await next.exited;
  });

  it("admits the next check after the active process is killed, without deleting lock metadata", async () => {
    const first = start(main);
    await first.ready;
    const second = start(worktree);
    await second.waiting;
    first.process.kill("SIGKILL");
    await first.exited;
    await second.ready;
    second.process.send({ code: 0 });
    expect(await second.exited).toEqual({ code: 0, signal: null });
  });

  it("releases the slot when loading the command fails", async () => {
    const failed = start(main, [], join(directory, "missing.mjs"));
    expect((await failed.exited).code).not.toBe(0);
    const next = start(worktree);
    await next.ready;
    next.process.send({ code: 0 });
    expect(await next.exited).toEqual({ code: 0, signal: null });
  });
});
