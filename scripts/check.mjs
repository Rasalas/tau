import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockOwner, tryLock } from "../src/main/process-lock.ts";

const require = createRequire(import.meta.url);

/** Git's common directory is shared by linked worktrees, including the main checkout. */
export function checkLockPath(cwd) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return join(realpathSync(common), "tau-check.lock");
}

/** Keep the check slot in Node, including when the compiler is a native executable. */
export async function runCheck(entry, args, cwd = process.cwd(), subprocess = false) {
  const path = checkLockPath(cwd);
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), dataFolder: cwd, app: "Tau checks" };
  let lock = await tryLock(path, owner);
  if (!lock) {
    const current = await lockOwner(path);
    console.error(`[check] Waiting for ${current?.dataFolder ?? "another Tau worktree"}${current ? ` (pid ${current.pid})` : ""}.`);
    while (!lock) {
      await new Promise((done) => setTimeout(done, 1_000));
      lock = await tryLock(path, owner);
    }
  }
  // Importing a CLI can return before its work finishes. Keep the slot until exit,
  // including watch mode; the OS also releases it after an unhandled signal.
  const release = () => lock.release();
  process.once("exit", release);
  process.argv = [process.execPath, entry, ...args];
  try {
    if (subprocess) {
      await new Promise((done, fail) => {
        const child = spawn(entry, args, { cwd, stdio: "inherit" });
        const interrupt = () => child.kill("SIGINT");
        const terminate = () => child.kill("SIGTERM");
        process.on("SIGINT", interrupt);
        process.on("SIGTERM", terminate);
        const cleanup = () => {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", terminate);
        };
        child.once("error", (error) => { cleanup(); fail(error); });
        child.once("close", (code, signal) => {
          cleanup();
          if (signal) process.kill(process.pid, signal);
          else process.exitCode = code ?? 1;
          done();
        });
      });
    } else {
      await import(pathToFileURL(entry).href);
    }
  } catch (error) {
    process.removeListener("exit", release);
    release();
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const cli = {
    test: ["vitest", "vitest.mjs"],
    typecheck: ["typescript-7", "bin/tsc"],
  }[command];
  if (!cli) throw new Error("Usage: node scripts/check.mjs <test|typecheck> [arguments...]");
  const [name, bin] = cli;
  const root = dirname(require.resolve(`${name}/package.json`));
  if (command === "typecheck") {
    // The package launcher can execve, which would discard Node's check lock.
    const { default: getExePath } = await import(pathToFileURL(join(root, "lib/getExePath.js")).href);
    await runCheck(getExePath(), args, process.cwd(), true);
  } else {
    await runCheck(join(root, bin), args);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[check] ${error.message}`);
    process.exitCode = 1;
  });
}
