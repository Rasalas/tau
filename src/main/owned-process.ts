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
  return spawnGuarded(input, false);
}

/** Shell background work stays owned until the host exits, even after the shell returns. */
export function spawnOwnedShellProcess(input: OwnedProcessInput): { child: ChildProcessWithoutNullStreams; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawnGuarded(input, true);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("message", (message) => resolve(message as { code: number | null; signal: NodeJS.Signals | null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  return { child, exited };
}

function spawnGuarded(input: OwnedProcessInput, retainAfterExit: boolean): ChildProcessWithoutNullStreams {
  const guardian = spawnGuardian(process.execPath, ["-e", `(${processGuardian.toString()})()`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
    // Survive a signal to the host's process group long enough to clean up.
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  guardian.send({ ...input, signal: undefined, retainAfterExit, token: randomUUID() }, () => undefined);
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
  const configuration = await new Promise<(OwnedProcessInput & { token: string; retainAfterExit: boolean }) | undefined>((resolve) => {
    process.once("message", (message) => resolve(message as OwnedProcessInput & { token: string; retainAfterExit: boolean }));
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
  // Capture descendants before EOF can make the CLI exit and orphan them.
  process.stdin.pipe(child.stdin, { end: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let stopping = false;
  let retaining = false;
  const observed = new Map<number, string>();

  // No command lines or environments leave this process.
  function owned(includeEnvironment = true): Map<number, string> {
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
      const fields = includeEnvironment ? ["axeww", "-o", "pid=,ppid=,lstart=,command="] : ["axo", "pid=,ppid=,lstart="];
      const output = execFileSync("/bin/ps", fields, { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 * 1024 });
      const rows = new Map<number, { parent: number; identity: string; marked: boolean }>();
      for (const row of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)(?:\s|$)/u.exec(row);
        if (match) rows.set(Number(match[1]), { parent: Number(match[2]), identity: match[3]!.replace(/\s+/gu, " "), marked: includeEnvironment && row.split(/\s+/u).includes(`${variable}=${input.token}`) });
      }
      // macOS hides environments of protected binaries such as /bin/sh.
      // Remember proven descendants while their parent exists, then retain
      // only the same PID and creation time when they become orphans.
      for (const [pid, row] of rows) {
        if (row.marked || observed.get(pid) === row.identity || (pid === child.pid && child.exitCode === null && child.signalCode === null)) found.set(pid, row.identity);
      }
      let added = true;
      while (added) {
        added = false;
        for (const [pid, row] of rows) if (!found.has(pid) && found.has(row.parent)) { found.set(pid, row.identity); added = true; }
      }
      observed.clear();
      for (const [pid, identity] of found) observed.set(pid, identity);
    }
    return found;
  }

  async function stop(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(observation);
    try { owned(); } catch { /* still signal the process group */ }
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
      if (child.pid) { try { process.kill(-child.pid, termination); } catch { /* gone */ } }
    };
    send("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    send("SIGKILL");
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  }

  // A CLI can exit before cleanup reads its children. Capture the ancestry
  // too; environment ownership remains sufficient on Linux.
  const observingSince = Date.now();
  let observation: ReturnType<typeof setTimeout> | undefined;
  const observe = () => {
    if (stopping) return;
    try {
      const remaining = owned(retaining);
      if (retaining && remaining.size === 0) {
        let groupAlive = false;
        if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, 0); groupAlive = true; } catch { /* gone */ } }
        if (!groupAlive) { process.exit(0); return; }
      }
    } catch { /* a stop still takes its own snapshot */ }
    // The first tools can fork and exit during CLI startup. Sample that
    // brief window more often, then reduce the steady-state overhead.
    observation = setTimeout(observe, Date.now() - observingSince < 1_000 ? 25 : 250);
    observation.unref();
  };
  if (process.platform === "darwin" || input.retainAfterExit) { observation = setTimeout(observe, 25); observation.unref(); }

  child.once("error", (error) => { process.stderr.write(`${error.message}\n`); void stop(1, null); });
  // An owner that dies also closes stdout/stderr. EPIPE must not kill the
  // guardian before it has finished stopping SIGTERM-resistant descendants.
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdout, child.stderr]) {
    stream.on("error", () => { void stop(null, "SIGTERM"); });
  }
  // Inherited stdout must not postpone cleanup until `close`.
  child.once("exit", (code, signal) => {
    if (input.retainAfterExit && code === 0 && !stopping) {
      retaining = true;
      process.send?.({ code, signal }, () => undefined);
      return;
    }
    void stop(code, signal);
  });
  process.stdin.once("end", () => {
    try { owned(); } catch { /* cleanup still takes its own snapshot */ }
    // One-shot requests close input before their answer. Preserve graceful
    // EOF while recording the descendants before the CLI can exit.
    child.stdin.end();
  });
  process.once("disconnect", () => { void stop(null, "SIGTERM"); });
  process.on("message", (message) => {
    const command = message as { stop?: NodeJS.Signals };
    if (command.stop) void stop(null, command.stop);
  });
  process.on("SIGTERM", () => { void stop(null, "SIGTERM"); });
  process.on("SIGINT", () => { void stop(null, "SIGINT"); });
  if (!process.connected) void stop(null, "SIGTERM");
}
