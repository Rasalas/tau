import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { cleanEnv } from "./run-command";

const SERVER = join(import.meta.dirname, "fake-ftp-server.mjs");

export interface RunningFtp { child: ChildProcess; port: number; cert: string | null }

/** The fake FTP server in its own process: ftp-srv exits whatever process it runs in on a signal. */
export function startFtpCli(dir: string, args: string[]): Promise<RunningFtp> {
  const child = spawn(process.execPath, [SERVER, "--dir", dir, ...args], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake-ftp-server exited with ${code}: ${output}`)));
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.startsWith("{"));
      if (!line || !output.includes("\n")) return;
      child.removeAllListeners("exit");
      const state = JSON.parse(line) as { port: number; cert: string | null };
      resolve({ child, port: state.port, cert: state.cert });
    });
  });
}

export async function stopFtpCli(running: RunningFtp | undefined): Promise<void> {
  if (!running || running.child.exitCode !== null) return;
  const exited = new Promise((resolve) => running.child.once("exit", resolve));
  running.child.kill("SIGTERM");
  await exited;
}
