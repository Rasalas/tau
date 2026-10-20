import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { processRunning as running } from "../../src/main/test-support/process-running.js";
import { HostProcessSupervisor } from "../../src/main/test-support/host-process-harness.js";
import { startOpenCodeServer } from "./server.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-process-serve.mjs", import.meta.url));
const source = fileURLToPath(new URL("./server.ts", import.meta.url));
const stub = fileURLToPath(new URL("../../src/main/test-support/stub-host.mjs", import.meta.url));
const api = fileURLToPath(new URL("../../src/main/host-extension-api.ts", import.meta.url));

it.skipIf(process.platform === "win32")("leaves no old server or tools after a host is killed and restarted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-server-owner-"));
  const entry = join(dir, "owner.mjs");
  await build({
    stdin: { contents: `import {startOpenCodeServer} from ${JSON.stringify(source)};
      await startOpenCodeServer({command:${JSON.stringify(fixture)},cwd:process.cwd(),env:{...process.env,FAKE_PROCESS_PIDS:process.env.TAU_USER_DATA+'/pids-'+process.pid}});
      await import(${JSON.stringify(pathToFileURL(stub).href)});`, resolveDir: process.cwd() },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", external: ["file://*"], alias: { "tau/host-extension": api },
  });
  const children: ReturnType<typeof spawn>[] = [];
  const supervisor = new HostProcessSupervisor({
    execPath: process.execPath, entry, userData: dir, version: "1.0.0", restartDelayMs: 0,
    env: { ...process.env, STUB_TOKEN_PATH: join(dir, "token"), STUB_WS_FROM: import.meta.filename, TAU_AGENT_SCOPES: "0" },
    spawnProcess: (command, args, env) => {
      const child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  });
  const other = await startOpenCodeServer({ command: fixture, cwd: dir, env: { ...process.env, FAKE_PROCESS_PIDS: join(dir, "other"), TAU_AGENT_SCOPES: "0" } });
  let oldPids: number[] = [];
  let otherPids: number[] = [];
  try {
    const first = await supervisor.start();
    await expect.poll(async () => {
      oldPids = await readFile(join(dir, `pids-${first.pid}`), "utf8").then((value) => JSON.parse(value) as number[]).catch(() => []);
      otherPids = await readFile(join(dir, "other"), "utf8").then((value) => JSON.parse(value) as number[]).catch(() => []);
      return [oldPids.length, otherPids.length];
    }).toEqual([2, 2]);
    expect([...oldPids, ...otherPids].every(running)).toBe(true);
    process.kill(first.pid, "SIGKILL");
    await expect.poll(() => supervisor.descriptor?.pid, { timeout: 20_000 }).not.toBe(first.pid);
    await expect.poll(() => oldPids.filter(running), { timeout: 10_000 }).toEqual([]);
    expect(otherPids.every(running)).toBe(true);
  } finally {
    await supervisor.stop();
    await other.close();
    const files = await readdir(dir);
    for (const file of files.filter((name) => name.startsWith("pids-"))) {
      const pids = JSON.parse(await readFile(join(dir, file), "utf8")) as number[];
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    for (const pid of otherPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

const sourcePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

it.skipIf(process.platform === "win32")("ends an OpenCode server when its extension worker is terminated without disposing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-opencode-owner-"));
  const entry = join(dir, "worker.cjs");
  let worker: Worker | undefined;
  let pid: number | undefined;
  try {
    // Exercise the kit's real spawn path and public API in the bundled form a
    // worker loads. Abrupt worker termination never calls server.close().
    await build({
      stdin: {
        contents: `
          import { parentPort } from "node:worker_threads";
          import { startOpenCodeServer } from ${JSON.stringify(sourcePath("./server.ts"))};
          async function main() {
          let pid;
          const server = await startOpenCodeServer({
            command: ${JSON.stringify(sourcePath("./fixtures/fake-serve-v2.mjs"))},
            cwd: ${JSON.stringify(dir)},
            env: { ...process.env, FAKE_IGNORE_TERM: "1" },
            wrap: ({ command, args }) => ({ command, args: [...args] }),
            onStderrLine: (line) => { const match = /^pid (\\d+)$/.exec(line); if (match) pid = Number(match[1]); },
          });
          parentPort.on("message", () => {});
          parentPort.postMessage({ pid, url: server.url });
          }
          main().catch((error) => { throw error; });
        `,
        resolveDir: process.cwd(),
        sourcefile: "opencode-owner.ts",
        loader: "ts",
      },
      alias: { "tau/host-extension": sourcePath("../../src/main/host-extension-api.ts") },
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
    });
    worker = new Worker(entry);
    const ready = await new Promise<{ pid: number; url: string }>((resolve, reject) => {
      worker!.once("message", resolve);
      worker!.once("error", reject);
      worker!.once("exit", (code) => reject(new Error(`OpenCode's owner exited before ready: ${code}`)));
    });
    pid = ready.pid;
    expect(pid).toBeGreaterThan(0);
    expect(running(pid)).toBe(true);
    expect((await fetch(ready.url)).ok).toBe(true);
    await worker.terminate();
    await expect.poll(() => running(pid!), { timeout: 5_000 }).toBe(false);
    await expect(fetch(ready.url)).rejects.toThrow();
  } finally {
    await worker?.terminate();
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
