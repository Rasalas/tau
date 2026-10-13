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
  const marker = `TAU_PROCESS_OWNER=${input.token}`;
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: { ...input.env, TAU_PROCESS_OWNER: input.token },
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
  interface Row { parent: number; group: number; identity: string; zombie: boolean; marked?: boolean }
  interface View { live: [pid: number, identity: string, group: number][]; group: boolean }
  let stopping = false;
  let retaining = false;
  let escalated = false;
  let exitedAt = 0;
  // PID plus start time of every process proven to be ours; a reused PID never matches.
  const tracked = new Map<number, string>();
  const unmarked = new Map<number, string>();
  let latest: View = { live: [], group: false };
  const listable = process.platform === "linux" || process.platform === "darwin";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const rootRunning = () => child.exitCode === null && child.signalCode === null;
  child.once("exit", () => { exitedAt = Date.now(); });

  // No command lines or environments leave this process.
  function table(withEnvironment: boolean): Map<number, Row> {
    const rows = new Map<number, Row>();
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          rows.set(Number(name), { zombie: fields[0] === "Z" || fields[0] === "X", parent: Number(fields[1]), group: Number(fields[2]), identity: fields[19]! });
        } catch { /* exited or inaccessible */ }
      }
    } else if (process.platform === "darwin") {
      // A fixed locale keeps the start time in one format.
      const output = execFileSync("/bin/ps", withEnvironment ? ["axeww", "-o", "pid=,ppid=,pgid=,lstart=,stat=,command="] : ["axo", "pid=,ppid=,pgid=,lstart=,stat="], {
        encoding: "utf8", timeout: withEnvironment ? 5_000 : 2_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
      });
      for (const row of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)(?:\s|$)/u.exec(row);
        if (match) rows.set(Number(match[1]), { parent: Number(match[2]), group: Number(match[3]), identity: match[4]!.replace(/\s+/gu, " "), zombie: match[5]!.startsWith("Z"), marked: withEnvironment ? row.split(/\s+/u).includes(marker) : undefined });
      }
    }
    return rows;
  }

  // macOS hides environments of protected binaries such as /bin/sh, so the marker is only a hint.
  function carries(pid: number, row: Row): boolean {
    if (row.marked !== undefined) return row.marked;
    if (process.platform !== "linux" || unmarked.get(pid) === row.identity) return false;
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)) return true;
      unmarked.set(pid, row.identity);
    } catch { /* exited or inaccessible */ }
    return false;
  }

  /** Our processes by ancestry, marker and process group, parents before their children. */
  function refresh(withEnvironment: boolean): View {
    const rows = table(withEnvironment);
    for (const [pid, identity] of unmarked) if (rows.get(pid)?.identity !== identity) unmarked.delete(pid);
    const found = new Map<number, string>();
    const root = rootRunning() ? child.pid : undefined;
    // Remembered processes keep their descendants even after the parent in between exited.
    for (const [pid, row] of rows) if (pid === root || tracked.get(pid) === row.identity) found.set(pid, row.identity);
    const descend = () => {
      for (let added = true; added;) {
        added = false;
        for (const [pid, row] of rows) if (!found.has(pid) && found.has(row.parent)) { found.set(pid, row.identity); added = true; }
      }
    };
    if (withEnvironment) for (const [pid, row] of rows) if (!found.has(pid) && carries(pid, row)) found.set(pid, row.identity);
    descend();
    // While one of ours lives in the group, no stranger can hold its number.
    const group = child.pid !== undefined && (rootRunning() || Date.now() - exitedAt < 2_000 || [...found.keys()].some((pid) => rows.get(pid)!.group === child.pid));
    if (group) {
      for (const [pid, row] of rows) if (row.group === child.pid && !found.has(pid)) found.set(pid, row.identity);
      descend();
    }
    const depth = (pid: number) => { let ancestors = 0; for (let next = rows.get(pid)!.parent; found.has(next) && ancestors < 256; next = rows.get(next)!.parent) ancestors++; return ancestors; };
    const live: View["live"] = [];
    tracked.clear();
    for (const [pid, identity] of found) {
      tracked.set(pid, identity);
      if (!rows.get(pid)!.zombie) live.push([pid, identity, rows.get(pid)!.group]);
    }
    live.sort((a, b) => depth(a[0]) - depth(b[0]));
    return (latest = { live, group });
  }

  const sent = new Set<string>();
  /** Signals a view without reading the process table: the group first, then the escapees. */
  function signal(termination: NodeJS.Signals, view: View): void {
    const group = child.pid !== undefined && (view.group || rootRunning() || Date.now() - exitedAt < 2_000);
    if (group && (termination !== "SIGTERM" || !sent.has("group"))) {
      sent.add("group");
      try { process.kill(-child.pid!, termination); } catch { /* gone */ }
    }
    for (const [pid, identity, processGroup] of view.live) {
      if (group && processGroup === child.pid) continue;
      if (termination === "SIGTERM") {
        if (sent.has(`${pid}:${identity}`)) continue;
        sent.add(`${pid}:${identity}`);
      }
      try { process.kill(pid, termination); } catch { /* gone */ }
    }
  }

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** Ends every descendant, also in foreign groups, and returns once none runs. */
  async function terminate(closeInput: () => void): Promise<void> {
    if (!listable) {
      closeInput();
      signal("SIGTERM", latest);
      await sleep(500);
      signal("SIGKILL", latest);
      return;
    }
    let view = latest;
    // An unreadable process table never counts as an empty one.
    const sweep = (withEnvironment: boolean) => {
      try { view = refresh(withEnvironment); return view.live.length; } catch {
        view = { group: latest.group, live: latest.live.filter(([pid]) => alive(pid)) };
        return view.live.length || 1;
      }
    };
    // Record the tree while its parents still live; ending input or signalling orphans their children.
    const empty = sweep(true) === 0;
    closeInput();
    if (empty) return;
    signal("SIGTERM", view);
    const graceEnds = Date.now() + 500;
    for (;;) {
      await sleep(25);
      if (sweep(false) === 0) return;
      if (escalated || Date.now() >= graceEnds) break;
      // A dying parent may start descendants; they are found while it still lives.
      signal("SIGTERM", view);
    }
    const killEnds = Date.now() + 3_000;
    signal("SIGKILL", view);
    for (;;) {
      await sleep(25);
      if (sweep(false) === 0) return;
      if (Date.now() >= killEnds) { process.stderr.write("Some processes survived SIGKILL.\n"); return; }
      signal("SIGKILL", view);
    }
  }

  async function stop(code: number | null, signalName: NodeJS.Signals | null): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(observation);
    const closeInput = () => {
      process.stdin.unpipe(child.stdin);
      child.stdin.destroy();
    };
    if (process.platform === "win32") {
      closeInput();
      const taskkill = () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const { win32 } = process.getBuiltinModule("path") as typeof import("node:path");
        const executable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        try { execFileSync(executable, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 2_000 }); } catch { /* gone */ }
      };
      taskkill();
      await sleep(500);
      taskkill();
    } else await terminate(closeInput);
    // Output written just before the exit may still sit in the pipes.
    const within = (work: Promise<unknown>) => Promise.race([work, sleep(500)]);
    await within(Promise.all([child.stdout, child.stderr].map((stream) => stream.readableEnded || stream.destroyed ? undefined : new Promise((resolve) => { stream.once("end", resolve); stream.once("close", resolve); }))));
    await within(Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => { stream.write("", resolve); }))));
    if (signalName) {
      process.removeAllListeners(signalName);
      process.kill(process.pid, signalName);
    } else process.exit(code ?? 1);
  }

  // A CLI can exit before cleanup reads its children, so ancestry is recorded as it grows.
  const observingSince = Date.now();
  let observation: ReturnType<typeof setTimeout> | undefined;
  const observe = () => {
    if (stopping) return;
    try {
      if (refresh(retaining).live.length === 0 && retaining) { process.exit(0); return; }
    } catch { /* a stop still takes its own snapshot */ }
    // The first tools can fork and exit during CLI startup. Sample that
    // brief window more often, then reduce the steady-state overhead.
    observation = setTimeout(observe, Date.now() - observingSince < 1_000 ? 25 : 250);
    observation.unref();
  };
  if (listable || input.retainAfterExit) { observation = setTimeout(observe, 25); observation.unref(); }

  child.once("error", (error) => { process.stderr.write(`${error.message}\n`); void stop(1, null); });
  // An owner that dies also closes stdout/stderr. EPIPE must not kill the
  // guardian before it has finished stopping SIGTERM-resistant descendants.
  for (const stream of [process.stdin, process.stdout, process.stderr, child.stdout, child.stderr]) {
    stream.on("error", () => { void stop(null, "SIGTERM"); });
  }
  // Inherited stdout must not postpone cleanup until `close`.
  child.once("exit", (code, exitSignal) => {
    if (input.retainAfterExit && code === 0 && !stopping) {
      retaining = true;
      process.send?.({ code, signal: exitSignal }, () => undefined);
      // Background work started just before the exit must be remembered while its group is provably ours.
      try { refresh(true); } catch { /* the next observation tries again */ }
      return;
    }
    void stop(code, exitSignal);
  });
  process.stdin.once("end", () => {
    try { refresh(true); } catch { /* cleanup still takes its own snapshot */ }
    // One-shot requests close input before their answer. Preserve graceful
    // EOF while recording the descendants before the CLI can exit.
    child.stdin.end();
  });
  process.once("disconnect", () => { void stop(null, "SIGTERM"); });
  process.on("message", (message) => {
    const command = message as { stop?: NodeJS.Signals };
    if (!command.stop) return;
    // A repeated SIGKILL request skips the grace period of a stop under way.
    if (stopping) { if (command.stop === "SIGKILL") escalated = true; } else void stop(null, command.stop);
  });
  process.on("SIGTERM", () => { void stop(null, "SIGTERM"); });
  process.on("SIGINT", () => { void stop(null, "SIGINT"); });
  if (!process.connected) void stop(null, "SIGTERM");
}
