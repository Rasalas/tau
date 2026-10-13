// Stops what the fake service manager started (`.fake-started.jsonl`), and only that:
// Includes orphaned descendants. Reads /proc, so Linux only; tests inject a probe.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const STARTED_LOG = ".fake-started.jsonl";

/** `/proc/<pid>/stat` after the command name, which may hold spaces and parentheses. */
export function parseProcStat(text) {
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(" ");
  return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), startTime: Number(fields[19]) };
}

export function procStat(pid) {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every process the fake started, oldest first; a torn last line is skipped. */
export function readStarted(unitDirectory) {
  let text = "";
  try { text = readFileSync(join(unitDirectory, STARTED_LOG), "utf8"); } catch { return []; }
  return text.split("\n").flatMap((line) => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

export const xLockPath = (number) => `/tmp/.X${number}-lock`;
export const xSocketPath = (number) => `/tmp/.X11-unix/X${number}`;

/** The machine as cleanup sees it. */
export const linuxProbe = {
  stat: procStat,
  pids: () => readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).map(Number),
  readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  exists: existsSync,
};

/** Same start time and not a zombie; without a recorded start time a reused pid cannot be ruled out. */
export function stillOurs(entry, probe) {
  const stat = probe.stat(entry.pid);
  return Boolean(stat) && stat.state !== "Z" && entry.startTime !== undefined && stat.startTime === entry.startTime;
}

/** The display's lock and socket, removable only when the lock names a process the smoke started that is gone now. */
export function displayLeftovers(number, started, probe) {
  const lock = xLockPath(number);
  const socket = xSocketPath(number);
  if (!probe.exists(lock)) {
    return probe.exists(socket) ? { remove: [], kept: [{ path: socket, reason: "no lock names its owner" }] } : { remove: [], kept: [] };
  }
  const pid = Number.parseInt(probe.readFile(lock)?.trim() ?? "", 10);
  const ours = started.find((entry) => entry.pid === pid);
  if (!ours) return { remove: [], kept: [{ path: lock, reason: `held by pid ${Number.isNaN(pid) ? "?" : pid}, which the smoke did not start` }] };
  if (stillOurs(ours, probe)) return { remove: [], kept: [{ path: lock, reason: `its Xvfb (pid ${pid}) still runs` }] };
  return { remove: [lock, ...(probe.exists(socket) ? [socket] : [])], kept: [] };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Find group members even after the leader exits, and detached processes using the isolated directories. */
export function smokeProcesses(started, directories, probe = linuxProbe, known = []) {
  const table = new Map((probe.pids?.() ?? started.map(({ pid }) => pid)).map((pid) => [pid, probe.stat(pid)]));
  const found = new Map();
  for (const [pid, stat] of table) {
    if (pid === process.pid || !stat || stat.state === "Z" || stat.startTime === undefined) continue;
    const recorded = [...started, ...known].find((entry) => entry.pid === pid && entry.startTime === stat.startTime);
    const group = started.find((entry) => {
      const leader = table.get(entry.pid);
      return entry.startTime !== undefined && stat.pgrp === entry.pid && stat.startTime >= entry.startTime
        && (!leader || leader.startTime === entry.startTime);
    });
    let reason = recorded ? "recorded process" : group ? `group of ${group.unit} pid ${group.pid}` : undefined;
    if (!reason && directories.length > 0) {
      for (const file of ["environ", "cmdline"]) {
        const values = (probe.readFile(`/proc/${pid}/${file}`) ?? "").split("\0");
        const path = directories.find((directory) => values.some((field) => {
          const value = field.slice(field.indexOf("=") + 1);
          return value === directory || value.startsWith(`${directory}/`);
        }));
        if (path) { reason = `${file === "environ" ? "environment" : "argument"} path ${path}`; break; }
      }
    }
    if (reason) found.set(pid, { ...stat, pid, unit: recorded?.unit ?? group?.unit ?? "smoke descendant", reason });
  }
  // A descendant may leave the group and replace its environment while its parent still lives.
  let added;
  do {
    added = false;
    for (const [pid, stat] of table) {
      if (pid === process.pid || !stat || stat.state === "Z" || found.has(pid)) continue;
      const parent = found.get(stat.ppid);
      if (parent && stat.startTime >= parent.startTime) {
        found.set(pid, { ...stat, pid, unit: parent.unit, reason: `child of pid ${parent.pid}` });
        added = true;
      }
    }
  } while (added);
  return [...found.values()].map((entry) => ({ ...entry, command: probe.readFile(`/proc/${entry.pid}/comm`)?.trim() ?? "unknown" }));
}

/** Wait for every descendant, including after SIGKILL. Synchronous for exit and signal handlers. */
export function stopStarted(input) {
  const { started, display, directories = [], probe = linuxProbe, graceMs = 5_000, killWaitMs = 1_000 } = input;
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal));
  const remove = input.remove ?? ((path) => rmSync(path, { force: true }));
  const sleep = input.sleep ?? sleepSync;
  const report = { stopped: [], gone: [], removed: [], kept: [], remaining: [] };
  const known = new Map();
  const signals = new Map();
  const identity = (entry) => `${entry.pid}:${entry.startTime}`;
  const discover = () => {
    const entries = smokeProcesses(started, directories, probe, [...known.values()]);
    for (const entry of entries) known.set(identity(entry), entry);
    return entries;
  };
  const signal = (entry, name) => {
    if (!stillOurs(entry, probe)) return;
    try { kill(entry.pid, name); } catch { /* gone meanwhile, or reported below */ }
    signals.set(identity(entry), name);
  };
  report.gone = started.filter((entry) => !stillOurs(entry, probe)).map(({ unit, pid }) => ({ unit, pid }));
  for (const [name, duration] of [["SIGTERM", graceMs], ["SIGKILL", killWaitMs]]) {
    for (let waited = 0; ; waited += 100) {
      const running = discover();
      if (running.length === 0) break;
      for (const entry of running) if (signals.get(identity(entry)) !== name) signal(entry, name);
      if (waited >= duration) break;
      sleep(100);
    }
  }
  report.remaining = discover();
  report.observed = [...known.values()];
  for (const entry of known.values()) if (!stillOurs(entry, probe)) {
    report.stopped.push({ unit: entry.unit, pid: entry.pid, signal: signals.get(identity(entry)) });
  }
  if (display !== undefined) {
    const { remove: paths, kept } = displayLeftovers(display, started, probe);
    for (const path of paths) {
      try { remove(path); report.removed.push(path); } catch (error) { report.kept.push({ path, reason: String(error?.message ?? error) }); }
    }
    report.kept.push(...kept);
  }
  return report;
}

/** One line per fact, for the smoke's log. */
export function describeCleanup(report) {
  const lines = [];
  for (const { unit, pid, signal } of report.stopped) lines.push(`stopped ${unit} pid ${pid} (${signal})`);
  for (const { unit, pid } of report.gone) lines.push(`${unit} pid ${pid} had already exited`);
  for (const path of report.removed) lines.push(`removed ${path}`);
  for (const { path, reason } of report.kept) lines.push(`left ${path}: ${reason}`);
  for (const entry of report.remaining ?? []) lines.push(`still running ${describeProcess(entry)}`);
  return lines.length > 0 ? lines : ["nothing to clean up"];
}

function describeProcess({ unit, command, pid, ppid, pgrp, startTime, reason }) {
  return `${unit} ${command} pid ${pid} ppid ${ppid} group ${pgrp} start ${startTime} (${reason})`;
}

/** A residual directory is diagnostic; a live smoke process makes cleanup fail. */
export function cleanSmoke(input) {
  const { directories, keep = false, probe = linuxProbe } = input;
  const report = stopStarted(input);
  const removeDirectory = input.removeDirectory ?? ((path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const list = input.list ?? ((path) => readdirSync(path, { recursive: true }).slice(0, 100));
  const log = input.log ?? console.error;
  if (!keep) for (const directory of directories) {
    try { removeDirectory(directory); } catch (error) {
      let entries;
      try { entries = list(directory); } catch (listError) { entries = [`cannot list: ${listError.message}`]; }
      report.remaining = smokeProcesses(input.started, directories, probe, report.observed);
      report.observed.push(...report.remaining);
      const processes = report.remaining.map(describeProcess);
      log(`cleanup: cannot remove ${directory}: ${error.code ?? error.message}\n  entries: ${entries.join(", ") || "none"}\n  live smoke processes: ${processes.join("; ") || "none"}`);
      report.kept.push({ path: directory, reason: error.code ?? error.message });
    }
  }
  report.remaining = smokeProcesses(input.started, directories, probe, report.observed);
  return report;
}
