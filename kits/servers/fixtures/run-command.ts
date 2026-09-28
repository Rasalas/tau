import { spawn, spawnSync } from "node:child_process";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command to its end, feeding `input` on stdin; never through a shell. */
export function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    // A child that exits before reading its input closes the pipe; its exit code still answers.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

export const hasCommand = (command: string, args: string[] = ["-V"]) => process.platform !== "win32" && spawnSync(command, args, { stdio: "ignore" }).error === undefined;

/** A PATH and HOME only: nothing of the developer's shell (agent, keychain helpers) reaches the child. */
export const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });
