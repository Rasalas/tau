import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitExecutable } from "tau/host-extension";
import type { AgentGitRunner } from "../workspace/agent-worktrees.js";

const execFileAsync = promisify(execFile);

export interface GitRunOptions {
  stdin?: string;
  indexFile?: string;
  /** 120 s by default; a clone of a large repository needs more. */
  timeoutMs?: number;
}

/**
 * Runs git and answers stdout; rejects like `execFile`, with `code`, `stdout`
 * and `stderr` on the error. Compatible with Workspace Kit's runner.
 */
export type GitRunner = (cwd: string, args: string[], options?: GitRunOptions) => Promise<string>;

export interface GitRunnerOptions {
  /** `-c` pairs put before every command. */
  config?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

// Variables that would point git at another repository than the one named.
const REPOSITORY_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/u;

export function createGitRunner({ config = [], env: base = process.env }: GitRunnerOptions = {}): GitRunner {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !REPOSITORY_ENV.test(key) && key !== "ELECTRON_RUN_AS_NODE"));
  const prefix = ["-c", "core.quotePath=false", ...config.flatMap((pair) => ["-c", pair])];
  return async (cwd, args, options = {}) => {
    const child = execFileAsync(gitExecutable(), [...prefix, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      env: options.indexFile ? { ...env, GIT_INDEX_FILE: options.indexFile, GIT_OPTIONAL_LOCKS: "0" } : env,
    });
    if (options.stdin !== undefined) child.child.stdin?.end(options.stdin);
    const { stdout } = await child;
    return stdout;
  };
}

/** The runner as Workspace Kit's leaf functions take it. */
export const asAgentRunner = (git: GitRunner): AgentGitRunner => (cwd, args, options) => git(cwd, args, options);

/**
 * Git on the receiving machine: no hooks (its user's global ones included),
 * no templates, no signing, no prompt for a password — nothing there may wait
 * on a person or run code the transfer brought along.
 */
export function receivingGitRunner(noHooksDir: string, env: NodeJS.ProcessEnv = process.env): GitRunner {
  return createGitRunner({
    config: [`core.hooksPath=${noHooksDir}`, "commit.gpgsign=false", "tag.gpgsign=false", "init.templateDir=", "core.fsmonitor=false"],
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      ...(env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
    },
  });
}

/** The first line of what git said, for a step's detail. */
export function gitMessage(error: unknown): string {
  const failure = error as { stderr?: unknown; message?: unknown };
  const text = typeof failure?.stderr === "string" && failure.stderr.trim() ? failure.stderr : typeof failure?.message === "string" ? failure.message : String(error);
  return text.trim().split("\n").map((line) => line.replace(/^(fatal|error): /u, "")).find((line) => line.trim()) ?? "git failed";
}
