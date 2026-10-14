import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    if (child.nativePid) { try { process.kill(child.nativePid, "SIGKILL"); } catch { /* exited */ } }
  }
  await Promise.all(children.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

function start(cwd, args = [], target = entry, subprocess = false) {
  const program = `import { runCheck } from ${JSON.stringify(runner)}; await runCheck(process.argv[1], process.argv.slice(2), process.cwd(), ${subprocess});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, target, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const state = { process: child, started: false, stderr: "" };
  state.ready = new Promise((done) => {
    const ready = (message) => {
      state.started = true;
      if (message.nativePid) { state.nativePid = message.nativePid; delete message.nativePid; }
      done(message);
    };
    child.once("message", ready);
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.includes("\n")) ready(JSON.parse(stdout.split("\n")[0]));
    });
  });
  state.waiting = new Promise((done) => child.stderr.on("data", (data) => {
    state.stderr += data;
    if (state.stderr.includes("[check] Waiting for")) done();
  }));
  state.exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  children.push(state);
  return state;
}

describe("checks across worktrees", () => {
  it("forwards termination to a subprocess before releasing the slot", async () => {
    const stopped = join(directory, "stopped");
    writeFileSync(entry, `
      import { writeFileSync } from "node:fs";
      const timer = setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {
        writeFileSync(${JSON.stringify(stopped)}, "stopped");
        clearInterval(timer);
      });
      console.log(JSON.stringify({ ready: true, nativePid: process.pid }));
    `);
    const first = start(main, [entry], process.execPath, true);
    expect(await Promise.race([first.ready, first.exited])).toEqual({ ready: true });
    first.process.kill("SIGTERM");
    expect(await first.exited).toEqual({ code: 0, signal: null });
    expect(readFileSync(stopped, "utf8")).toBe("stopped");
    writeFileSync(entry, 'process.send({}); process.on("message", () => process.exit(0));');
    const next = start(worktree);
    await next.ready;
    next.process.send({ code: 0 });
    expect(await next.exited).toEqual({ code: 0, signal: null });
  });

  it("releases the slot when starting a subprocess fails", async () => {
    const failed = start(main, [], join(directory, "missing-binary"), true);
    expect((await failed.exited).code).not.toBe(0);
    const next = start(worktree);
    await next.ready;
    next.process.send({ code: 0 });
    expect(await next.exited).toEqual({ code: 0, signal: null });
  });

  it("holds the slot until a subprocess exits and preserves its exit code", async () => {
    writeFileSync(entry, `
      process.stdin.once("data", () => process.exit(7));
      console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), nativePid: process.pid }));
    `);
    const first = start(main, [entry, "file with spaces.ts", "--noEmit"], process.execPath, true);
    expect(await Promise.race([first.ready, first.exited])).toEqual({ args: ["file with spaces.ts", "--noEmit"], cwd: main });
    writeFileSync(join(directory, "second.mjs"), 'process.send({}); process.on("message", () => process.exit(0));');
    const second = start(worktree, [], join(directory, "second.mjs"));
    await second.waiting;
    expect(second.started).toBe(false);
    first.process.stdin.write("done");
    expect(await first.exited).toEqual({ code: 7, signal: null });
    await second.ready;
    second.process.send({ code: 0 });
    expect(await second.exited).toEqual({ code: 0, signal: null });
  });

  it("selects TypeScript 7 for checks and keeps the emitting compiler on 5.9", () => {
    const version = execFileSync(process.execPath, [fileURLToPath(runner), "typecheck", "--version"], { cwd: main, encoding: "utf8" });
    expect(version.trim()).toBe("Version 7.0.2");
    const root = new URL("../", import.meta.url);
    const api = JSON.parse(readFileSync(new URL("node_modules/typescript/package.json", root), "utf8"));
    expect(api.version).toMatch(/^5\.9\./u);
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(pkg.scripts.dev).toContain("node node_modules/typescript/bin/tsc -p tooling/tsconfig.electron.json --watch");
    expect(readFileSync(new URL("scripts/build.mjs", root), "utf8")).toContain('run("typescript/bin/tsc",');
  });

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
