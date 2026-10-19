import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { gitEnvironment, gitExecutable } from "tau/host-extension";

const execFileAsync = promisify(execFile);

export type GitRunner = (cwd: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<string>;
export type SnapshotGitRunner = (
  cwd: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

function gitCommandTimeout(input: readonly string[]): number {
  let offset = 0;
  while (input[offset] === "-c") offset += 2;
  const args = input.slice(offset);
  if (["commit", "pull", "push", "clean", "read-tree"].includes(args[0] ?? "")) return 0;
  if (args[0] === "worktree" && (args[1] === "add" || args[1] === "remove")) return 5 * 60 * 1000;
  return 10_000;
}

export async function runGitCommand(
  cwd: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  timeout = gitCommandTimeout(args),
): Promise<string> {
  const run = () => execFileAsync(gitExecutable(), ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    maxBuffer,
    timeout,
    signal,
    env: gitEnvironment({ ...(env ?? process.env), GIT_OPTIONAL_LOCKS: "0" }),
    windowsHide: true,
  });
  const { stdout } = await run().catch(async (error: unknown) => {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    if (signal?.aborted || typeof stderr !== "string"
      || !/unable to create [^\n]*[\\/]index\.lock['"]?: file exists/iu.test(stderr)) throw error;
    await delay(75, undefined, { signal });
    return run();
  });
  return stdout;
}
