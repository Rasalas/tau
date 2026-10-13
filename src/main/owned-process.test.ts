import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { spawnOwnedProcess } from "./owned-process.js";

const fixture = fileURLToPath(new URL("../../kits/claude-code/fixtures/process-tree-cli.mjs", import.meta.url));
const escaping = fileURLToPath(new URL("./test-support/escaping-process-tree.mjs", import.meta.url));
const spawnOnTerm = fileURLToPath(new URL("./test-support/spawn-on-term.mjs", import.meta.url));
function running(pid: number): boolean {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; }
}
async function fixturePids(dir: string): Promise<number[]> {
  let pids: number[] = [];
  await expect.poll(async () => {
    pids = await readFile(join(dir, "pids"), "utf8").then((text) => text.trim().split(/\s+/u).map(Number)).catch(() => []);
    return pids.length;
  }, { timeout: 20_000 }).toBe(2);
  return [Number(await readFile(join(dir, "root"), "utf8")), ...pids];
}
function environment(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, TAU_PROCESS_FIXTURE_ROOT: join(dir, "root"), TAU_PROCESS_FIXTURE_PIDS: join(dir, "pids") };
}
function cleanup(pids: number[]): void {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

it("allows a one-shot CLI to finish its answer after input reaches EOF", async () => {
  const child = spawnOwnedProcess({ command: process.execPath, args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.stdout.write('finished'), 100));"], env: process.env });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    child.stdin.end();
    await exited;
    expect(output).toBe("finished");
    expect(child.exitCode).toBe(0);
  } finally { child.kill("SIGKILL"); }
});

it("delivers everything a command wrote before it exited", async () => {
  const child = spawnOwnedProcess({ command: process.execPath, args: ["-e", "process.stdout.write('o'.repeat(500000)); process.stderr.write('e'.repeat(200000))"], env: process.env });
  const received = { out: 0, err: 0 };
  child.stdout.on("data", (chunk: Buffer) => { received.out += chunk.length; });
  child.stderr.on("data", (chunk: Buffer) => { received.err += chunk.length; });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin.end();
  await exited;
  expect(received).toEqual({ out: 500_000, err: 200_000 });
});

it.skipIf(process.platform === "win32")("accepts a stop before the guardian finished starting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-owned-early-stop-"));
  const child = spawnOwnedProcess({ command: process.execPath, args: [fixture], env: environment(dir) });
  try {
    child.kill("SIGKILL");
    await expect.poll(() => child.signalCode, { timeout: 20_000 }).toBe("SIGKILL");
  } finally {
    child.kill("SIGTERM");
    const pids = await readFile(join(dir, "pids"), "utf8").then((text) => text.trim().split(/\s+/u).map(Number)).catch(() => []);
    cleanup(pids);
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32").each(["EOF", "SIGTERM", "SIGKILL", 15, "CLI crash"] as const)("cleans up detached, SIGTERM-resistant descendants on %s", async (action) => {
  const dir = await mkdtemp(join(tmpdir(), "tau-owned-process-"));
  const child = spawnOwnedProcess({ command: process.execPath, args: [fixture], env: environment(dir) });
  let pids: number[] = [];
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    pids = await fixturePids(dir);
    expect(pids.every(running)).toBe(true);
    if (action === "EOF") child.stdin.end();
    else if (action === "CLI crash") {
      // A crash right after the tree appeared would beat the guardian's first samples.
      await new Promise((resolve) => setTimeout(resolve, 300));
      process.kill(pids[0]!, "SIGKILL");
    }
    else child.kill(action);
    await exited;
    await expect.poll(() => pids.filter(running), { timeout: 20_000 }).toEqual([]);
  } finally {
    child.kill();
    cleanup(pids);
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("survives an owner's SIGKILL and leaves another owner's work alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-owned-host-"));
  const otherDir = await mkdtemp(join(tmpdir(), "tau-other-host-"));
  const bundled = join(dir, "owned.cjs");
  // The real kits load the API from a bundled worker. Exercise that form too.
  await build({ entryPoints: [fileURLToPath(new URL("./owned-process.ts", import.meta.url))], outfile: bundled, bundle: true, platform: "node", format: "cjs", target: "node22" });
  const ownerFile = join(dir, "owner.cjs");
  await writeFile(ownerFile, `const {spawnOwnedProcess}=require(${JSON.stringify(bundled)}); const child=spawnOwnedProcess({command:process.execPath,args:[${JSON.stringify(fixture)}],env:process.env}); require('node:fs').writeFileSync(${JSON.stringify(join(dir, "guardian"))},String(child.pid));`);
  const owner = spawn(process.execPath, [ownerFile], { env: { ...environment(dir), TAU_PROCESS_FIXTURE_NOISY: "1" }, stdio: "ignore" });
  const other = spawnOwnedProcess({ command: process.execPath, args: [fixture], env: environment(otherDir) });
  const otherExited = new Promise((resolve) => other.once("exit", resolve));
  let pids: number[] = [];
  let otherPids: number[] = [];
  try {
    pids = await fixturePids(dir);
    otherPids = await fixturePids(otherDir);
    const guardian = Number(await readFile(join(dir, "guardian"), "utf8"));
    const ownerExited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGKILL");
    await ownerExited;
    await expect.poll(() => [...pids, guardian].filter(running), { timeout: 20_000 }).toEqual([]);
    expect(otherPids.every(running)).toBe(true);
  } finally {
    owner.kill("SIGKILL");
    other.stdin.end();
    await otherExited;
    cleanup([...pids, ...otherPids]);
    await rm(dir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("ends descendants that lost the marker, left the process group or lost their parent, and exits only afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-owned-escape-"));
  const record = join(dir, "pids");
  // `env -i` drops the ownership marker for every descendant.
  const child = spawnOwnedProcess({ command: "/usr/bin/env", args: ["-i", process.execPath, escaping, record], env: process.env });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let pids: number[] = [];
  try {
    await expect.poll(async () => {
      pids = await readFile(record, "utf8").then((text) => JSON.parse(text) as number[]).catch(() => []);
      const orphan = Number(await readFile(`${record}.orphan`, "utf8").catch(() => 0));
      if (orphan) pids = [...pids, orphan];
      return pids.length === 5 && !running(pids[3]!);
    }, { timeout: 20_000 }).toBe(true);
    expect(pids.filter((pid) => pid !== pids[3]).every(running)).toBe(true);
    child.kill("SIGTERM");
    await exited;
    // No polling: the guardian reports its exit only after the last descendant is gone.
    expect(pids.filter(running)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    cleanup(pids);
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("also ends a descendant which a dying parent starts during the stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-owned-late-"));
  const record = join(dir, "helper");
  const child = spawnOwnedProcess({ command: "/usr/bin/env", args: ["-i", process.execPath, spawnOnTerm, record], env: process.env });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let pids: number[] = [];
  try {
    await expect.poll(() => readFile(`${record}.ready`, "utf8").then(() => true, () => false), { timeout: 20_000 }).toBe(true);
    child.kill("SIGTERM");
    await exited;
    pids = [Number(await readFile(record, "utf8"))];
    expect(pids[0]).toBeGreaterThan(0);
    expect(pids.filter(running)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    cleanup(pids.length ? pids : [Number(await readFile(record, "utf8").catch(() => 0))]);
    await rm(dir, { recursive: true, force: true });
  }
});
