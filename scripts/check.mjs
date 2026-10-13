import { execFileSync } from "node:child_process";
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

/** Load the CLI in the lock holder itself, so a killed compiler cannot leave a stale lock. */
export async function runCheck(entry, args, cwd = process.cwd()) {
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
    await import(pathToFileURL(entry).href);
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
    typecheck: ["typescript", "bin/tsc"],
  }[command];
  if (!cli) throw new Error("Usage: node scripts/check.mjs <test|typecheck> [arguments...]");
  const [name, bin] = cli;
  const entry = join(dirname(require.resolve(`${name}/package.json`)), bin);
  await runCheck(entry, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[check] ${error.message}`);
    process.exitCode = 1;
  });
}
