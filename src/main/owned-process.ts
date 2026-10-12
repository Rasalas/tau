import { spawn as spawnGuardian, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";

export interface OwnedProcessInput {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  signal?: AbortSignal;
}

/** A private IPC connection ties a CLI and its descendants to the caller, even after SIGKILL. */
export function spawnOwnedProcess(input: OwnedProcessInput): ChildProcessWithoutNullStreams {
  const guardian = spawnGuardian(process.execPath, ["-e", `(${processGuardian.toString()})()`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
    // Survive a signal to the host's process group long enough to clean up.
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  guardian.send({ ...input, signal: undefined, token: randomUUID() }, () => undefined);
  // SIGKILL targets the work, not the guardian that still has to reap it.
  guardian.kill = (signal = "SIGTERM") => {
    if (!guardian.connected || guardian.exitCode !== null || guardian.signalCode !== null) return false;
    if (signal === 0) return true;
    const termination = typeof signal === "number" ? Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] : signal;
    if (!termination) throw new TypeError(`Unknown signal: ${signal}`);
    Object.defineProperty(guardian, "killed", { value: true, configurable: true });
    guardian.send({ stop: termination }, () => undefined);
    return true;
  };
  const abort = () => { guardian.kill("SIGTERM"); };
  input.signal?.addEventListener("abort", abort, { once: true });
  guardian.once("exit", () => {
    input.signal?.removeEventListener("abort", abort);
  });
  if (input.signal?.aborted) abort();
  return guardian;
}

/** Self-contained Node program, serialized in both the host and bundled kit workers. */
async function processGuardian(): Promise<void> {
  // Built-ins keep this function independent of bundler import rewrites.
  const { spawn, execFileSync } = process.getBuiltinModule("child_process") as typeof import("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("fs") as typeof import("node:fs");
  const configuration = await new Promise<(OwnedProcessInput & { token: string }) | undefined>((resolve) => {
    process.once("message", (message) => resolve(message as OwnedProcessInput & { token: string }));
    process.once("disconnect", () => resolve(undefined));
  });
  if (!configuration) return;
  const input = configuration;
  const variable = "TAU_PROCESS_OWNER";
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: { ...input.env, [variable]: input.token },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: input.windowsVerbatimArguments,
  });
  child.stdin.on("error", () => undefined);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let stopping = false;

  // No command lines or environments leave this process.
  function owned(): Map<number, string> {
    const found = new Map<number, string>();
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          if (!readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`${variable}=${input.token}`)) continue;
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          found.set(Number(name), stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!);
        } catch { /* exited or inaccessible */ }
      }
    } else if (process.platform === "darwin") {
      const output = execFileSync("/bin/ps", ["axeww", "-o", "pid=,lstart=,command="], { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 * 1024 });
      for (const row of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s/u.exec(row);
        if (match && row.split(/\s+/u).includes(`${variable}=${input.token}`)) found.set(Number(match[1]), match[2]!);
      }
    }
    return found;
  }

  async function stop(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.destroy();
    const send = (termination: NodeJS.Signals) => {
      if (process.platform === "win32") {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const { win32 } = process.getBuiltinModule("path") as typeof import("node:path");
          const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
          try { execFileSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 2_000 }); } catch { /* gone */ }
        }
        return;
      }
      let processes = new Map<number, string>();
      try { processes = owned(); } catch { /* still signal the process group */ }
      for (const [pid, identity] of processes) {
        try {
          // Creation time guards against signalling a reused PID.
          if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== identity) continue;
            if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${variable}=${input.token}`)) continue;
          } else {
            const start = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 }).trim();
            if (start.replace(/\s+/gu, " ") !== identity.replace(/\s+/gu, " ")) continue;
          }
          process.kill(pid, termination);
        } catch { /* gone */ }
      }
      // Also covers descendants that replaced their environment inside this group.
      if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, termination); } catch { /* gone */ } }
    };
    send("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    send("SIGKILL");
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  }

  child.once("error", (error) => { process.stderr.write(`${error.message}\n`); void stop(1, null); });
  // An owner that dies also closes stdout/stderr. EPIPE must not kill the
  // guardian before it has finished stopping SIGTERM-resistant descendants.
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdout, child.stderr]) {
    stream.on("error", () => { void stop(null, "SIGTERM"); });
  }
  // Inherited stdout must not postpone cleanup until `close`.
  child.once("exit", (code, signal) => { void stop(code, signal); });
  process.once("disconnect", () => { void stop(null, "SIGTERM"); });
  process.on("message", (message) => {
    const command = message as { stop?: NodeJS.Signals };
    if (command.stop) void stop(null, command.stop);
  });
  process.on("SIGTERM", () => { void stop(null, "SIGTERM"); });
  process.on("SIGINT", () => { void stop(null, "SIGINT"); });
  if (!process.connected) void stop(null, "SIGTERM");
}
