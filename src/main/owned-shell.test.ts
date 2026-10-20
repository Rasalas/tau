import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { processRunning } from "./test-support/process-running.js";
import { spawnOwnedShellProcess } from "./owned-process.js";
import { ownedBashOperations } from "./owned-shell.js";

vi.mock("./owned-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./owned-process.js")>();
  return { ...actual, spawnOwnedShellProcess: vi.fn(actual.spawnOwnedShellProcess) };
});

it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGKILL"] as const)("retains background shell work after success and ends it on owner %s", async (signal) => {
  const dir = await mkdtemp(join(tmpdir(), "tau-shell-owner-"));
  const bundled = join(dir, "owned.cjs");
  const fixture = fileURLToPath(new URL("./test-support/shell-process-tree.mjs", import.meta.url));
  await build({ entryPoints: [fileURLToPath(new URL("./owned-process.ts", import.meta.url))], outfile: bundled, bundle: true, platform: "node", format: "cjs", target: "node22" });
  const ownerFile = join(dir, "owner.cjs");
  const done = join(dir, "done");
  const record = join(dir, "pids");
  await writeFile(ownerFile, `const fs=require('node:fs');
    const {child,exited}=require(${JSON.stringify(bundled)}).spawnOwnedShellProcess({command:process.execPath,args:[${JSON.stringify(fixture)}],env:{...process.env,TAU_SHELL_BACKGROUND_FIXTURE:'1'}});
    child.stdout.once('data',chunk=>fs.writeFileSync(${JSON.stringify(record)},JSON.stringify([child.pid,...JSON.parse(String(chunk))])));
    child.stdin.end();
    exited.then(result=>fs.writeFileSync(${JSON.stringify(done)},JSON.stringify(result)));`);
  const owner = spawn(process.execPath, [ownerFile], { env: process.env, stdio: "ignore" });
  let pids: number[] = [];
  try {
    await expect.poll(async () => readFile(done, "utf8").catch(() => "")).toBe('{"code":0,"signal":null}');
    pids = JSON.parse(await readFile(record, "utf8")) as number[];
    const [guardian, , background] = pids;
    expect(processRunning(guardian!)).toBe(true);
    expect(processRunning(background!)).toBe(true);
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill(signal);
    await exited;
    await expect.poll(() => pids.filter(processRunning), { timeout: 10_000 }).toEqual([]);
  } finally {
    owner.kill("SIGKILL");
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([0, -1, Infinity, NaN, 2_147_484])("rejects an invalid timeout %s before starting a shell", async (timeout) => {
  const operations = ownedBashOperations({ getShellPath: () => undefined });
  await expect(operations.exec("echo never", process.cwd(), { onData: () => undefined, timeout })).rejects.toThrow("Invalid shell timeout");
});

it("returns the exit status while a background job it left keeps writing", async () => {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams;
  vi.mocked(spawnOwnedShellProcess).mockReturnValueOnce({ child, exited: Promise.resolve({ code: 3, signal: null }) });
  // `docker compose logs -f &`: the pipe never goes quiet.
  const chatter = setInterval(() => stdout.write("log line\n"), 10);
  try {
    const operations = ownedBashOperations({ getShellPath: () => undefined });
    expect(await operations.exec("docker compose logs -f &", process.cwd(), { onData: () => undefined })).toEqual({ exitCode: 3 });
  } finally {
    clearInterval(chatter);
  }
});
