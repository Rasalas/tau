import { spawn } from "node:child_process";

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface GitCallOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: Buffer | string;
  signal?: AbortSignal;
}

/** Runs git, feeding `input`; never throws for an exit code, only when git cannot start. */
export type GitCall = (args: readonly string[], options?: GitCallOptions) => Promise<GitResult>;

// Variables that would point git at another repository than the one named.
const REPOSITORY_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/u;

export function gitCall(git = "git", onSpawn?: () => void): GitCall {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!REPOSITORY_ENV.test(key)) env[key] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, options.env);
    onSpawn?.();
    const child = spawn(git, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8"); });
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(options.input ?? "");
  });
}

export class GitError extends Error {
  constructor(args: readonly string[], result: GitResult) {
    super(`git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
    this.name = "GitError";
  }
}

export async function gitOk(call: GitCall, args: readonly string[], options?: GitCallOptions): Promise<Buffer> {
  const result = await call(args, options);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout;
}
