import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runFault(kind: "rejection" | "exception" | "value") {
  const dir = await mkdtemp(join(tmpdir(), "tau-process-errors-"));
  directories.push(dir);
  const script = join(dir, "fixture.cjs");
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { HostLog } from "./src/main/host-log.js";
        import { installHostProcessErrorHandlers } from "./src/main/host-process-errors.js";
        import { HostExtensionRegistry } from "./src/main/host-extensions.js";
        const log = new HostLog({ dir: process.argv[2], fileName: "host-process.log", mirrorToConsole: false });
        installHostProcessErrorHandlers(log);
        const registry = new HostExtensionRegistry({
          cwd: () => process.argv[2], stateDir: process.argv[2], safeMode: false, log: () => {},
        }, () => {});
        async function main() {
          if (!await registry.activate({
            id: "test.fault", name: "Fault kit", activate(context) {
              context.registerCommand("fault", () => {
                if (process.argv[3] === "exception") {
                  setImmediate(() => { throw new Error("kit exception"); });
                } else {
                  void Promise.reject(process.argv[3] === "value" ? { code: "ENOSPC" } : new Error("kit persist ENOSPC"));
                }
              });
              context.registerCommand("probe", () => "still serving");
            },
          })) throw new Error("activation failed");
          await registry.invoke("test.fault", "fault");
          await new Promise(resolve => setImmediate(resolve));
          console.log(await registry.invoke("test.fault", "probe"));
          await registry.dispose();
        }
        main().catch(error => { console.error(error); process.exit(2); });
      `,
    },
    outfile: script, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
  });
  const result = spawnSync(process.execPath, ["--unhandled-rejections=throw", script, dir, kind], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: dir },
  });
  const log = await readFile(join(dir, "host-process.log"), "utf8").catch(() => "");
  return { result, log };
}

describe("host process errors", () => {
  it("keeps serving kit commands after an unhandled rejection and logs its stack", async () => {
    const { result, log } = await runFault("rejection");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("still serving");
    expect(log).toContain('ERROR process.unhandledRejection {"name":"Error","message":"kit persist ENOSPC","stack":');
  });

  it("logs non-Error rejection reasons and keeps serving", async () => {
    const { result, log } = await runFault("value");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("still serving");
    expect(log).toContain('ERROR process.unhandledRejection {"code":"ENOSPC"}');
  });

  it("logs uncaught exceptions before exiting with failure", async () => {
    const { result, log } = await runFault("exception");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).not.toContain("still serving");
    expect(log).toContain('ERROR process.uncaughtException {"name":"Error","message":"kit exception","stack":');
  });

  it("installs the handlers before the headless host initializes its state", async () => {
    const source = await readFile(new URL("./headless.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const hostLog = new HostLog\([^;]+;\s*installHostProcessErrorHandlers\(hostLog\);\s*const hostId/u);
  });
});
