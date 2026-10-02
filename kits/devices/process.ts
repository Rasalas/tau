import { spawn, type ChildProcess } from "node:child_process";
export interface ProcessResult { stdout: string; stderr: string }
export type Run = (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<ProcessResult>;
const MAX_OUTPUT = 8 * 1024 * 1024;
export const run: Run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["AGENT_DEVICE_DAEMON_BASE_URL", "AGENT_DEVICE_DAEMON_AUTH_TOKEN", "AGENT_DEVICE_CONFIG"]) delete env[key];
  const child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (error) { child.kill(); reject(error); } else resolve({ stdout, stderr });
  };
  const abort = () => finish(new Error("Device operation cancelled."));
  const timer = setTimeout(() => finish(new Error("Device operation timed out.")), options.timeout ?? 60_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > MAX_OUTPUT) finish(new Error("Device output exceeded its limit.")); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > MAX_OUTPUT) finish(new Error("Device output exceeded its limit.")); });
  child.on("error", finish);
  child.on("exit", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `Device command exited ${String(code)}.`)));
});
/** Quote each SSH argument. SSH executes its command through the remote login shell. */
export const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function stop(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
  timer.unref();
}
