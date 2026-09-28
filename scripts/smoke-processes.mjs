// Stops what the fake service manager started (`.fake-started.jsonl`), and only that:
// pid and start time must match. Reads /proc, so Linux only; tests inject a probe.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const STARTED_LOG = ".fake-started.jsonl";

/** `/proc/<pid>/stat` after the command name, which may hold spaces and parentheses. */
export function parseProcStat(text) {
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(" ");
  return { state: fields[0], pgrp: Number(fields[2]), startTime: Number(fields[19]) };
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

/** SIGTERM to each group, SIGKILL after `graceMs`, then the display's own leftovers. Synchronous for exit and signal handlers. */
export function stopStarted(input) {
  const { started, display, probe = linuxProbe, graceMs = 5_000 } = input;
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal));
  const remove = input.remove ?? ((path) => rmSync(path, { force: true }));
  const sleep = input.sleep ?? sleepSync;
  const report = { stopped: [], gone: [], removed: [], kept: [] };
  const signal = (entry, name) => {
    // The fake starts every unit detached, so a group whose leader is ours holds only its descendants.
    const group = probe.stat(entry.pid)?.pgrp === entry.pid;
    try { kill(group ? -entry.pid : entry.pid, name); } catch { /* gone meanwhile */ }
  };
  const running = started.filter((entry) => stillOurs(entry, probe));
  report.gone = started.filter((entry) => !running.includes(entry)).map(({ unit, pid }) => ({ unit, pid }));
  for (const entry of running) signal(entry, "SIGTERM");
  for (let waited = 0; waited < graceMs && running.some((entry) => stillOurs(entry, probe)); waited += 100) sleep(100);
  for (const entry of running) {
    const killed = stillOurs(entry, probe);
    if (killed) signal(entry, "SIGKILL");
    report.stopped.push({ unit: entry.unit, pid: entry.pid, signal: killed ? "SIGKILL" : "SIGTERM" });
  }
  if (display !== undefined) {
    if (running.some((entry) => stillOurs(entry, probe))) sleep(200);
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
  return lines.length > 0 ? lines : ["nothing to clean up"];
}
