import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { spawnOwnedProcess } from "./owned-process.js";

const fixture = fileURLToPath(new URL("../../kits/claude-code/fixtures/process-tree-cli.mjs", import.meta.url));
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
    else if (action === "CLI crash") process.kill(pids[0]!, "SIGKILL");
    else child.kill(action);
    await exited;
    expect(pids.filter(running)).toEqual([]);
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
