import { execFileSync } from "node:child_process";

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** `ps` rows as { pid, ppid, rssKiB, command }. */
export function parsePs(output) {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }] : [];
  });
}

export function processTable() {
  return parsePs(execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

/** Cumulative user + system CPU time, as printed by BSD or procps `ps`. */
export function parseCpuTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(value);
  if (!match) throw new Error(`invalid CPU time: ${value}`);
  return Math.round((Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000);
}

export function parseCpuPs(output) {
  return output.split("\n").filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/u.exec(line);
    if (!match) throw new Error("unrecognized CPU process row");
    return { pid: Number(match[1]), ppid: Number(match[2]), cpuMs: parseCpuTime(match[3]), started: match[4].replaceAll(/\s+/gu, " "), command: match[5] };
  });
}

function cpuProcessTable() {
  return parseCpuPs(execFileSync("ps", ["-Ao", "pid=,ppid=,time=,lstart=,command="], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
  }));
}

/** Discard a window with process churn rather than report lost CPU as zero. */
export function cpuDelta(before, after, roots, windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("CPU window must be positive");
  const tree = (rows) => descendants(rows, roots).filter((row) => processRole(row.command) !== "excluded");
  const first = new Map(tree(before).map((row) => [row.pid, row]));
  const last = tree(after);
  let complete = roots.every((pid) => first.has(pid) && last.some((row) => row.pid === pid)) && first.size === last.length;
  const byRoleMs = {};
  for (const row of last) {
    const previous = first.get(row.pid);
    if (!previous || previous.started !== row.started || previous.command !== row.command || row.cpuMs < previous.cpuMs) {
      complete = false;
      continue;
    }
    const role = processRole(row.command);
    byRoleMs[role] = (byRoleMs[role] ?? 0) + row.cpuMs - previous.cpuMs;
  }
  const rounded = (value) => Math.round(value * 100) / 100;
  const totalMs = Object.values(byRoleMs).reduce((sum, value) => sum + value, 0);
  return {
    complete, windowMs: rounded(windowMs), processes: last.length,
    totalMs: complete ? totalMs : null,
    totalPercent: complete ? rounded(totalMs / windowMs * 100) : null,
    byRoleMs: complete ? byRoleMs : {},
    byRolePercent: complete ? Object.fromEntries(Object.entries(byRoleMs).map(([role, ms]) => [role, rounded(ms / windowMs * 100)])) : {},
  };
}

export async function measureIdleCpu(roots, idleMs, { readTable = cpuProcessTable, now = () => performance.now(), wait: pause = wait } = {}) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("idle CPU window must be positive");
  const before = readTable();
  const started = now();
  await pause(idleMs);
  const after = readTable();
  return cpuDelta(before, after, roots, now() - started);
}

/** Every process under the given roots, roots included. */
export function descendants(rows, roots) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = new Map();
  const queue = rows.filter((row) => roots.includes(row.pid));
  while (queue.length) {
    const row = queue.shift();
    if (found.has(row.pid)) continue;
    found.set(row.pid, row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return [...found.values()];
}

/** A coarse role from the command line; the harness's own fake CLI is `excluded`. */
export function processRole(command) {
  if (/fake-codex\.mjs/u.test(command)) return "excluded";
  if (/--type=renderer/u.test(command)) return "renderer";
  if (/--type=gpu-process/u.test(command)) return "gpu";
  if (/--type=/u.test(command)) return "utility";
  // Tau's host and the reference app's server both run as Electron-as-Node children of the main process.
  if (/dist-electron\/main\/headless\.js|apps\/server\/dist\/bin\.mjs/u.test(command)) return "backend";
  if (/Electron\.app\/Contents\/MacOS\/Electron|[\\/]electron(?:\.exe)?(?:\s|$)/iu.test(command)) return "main";
  return "other";
}

/** `footprint -f bytes` output as a map of pid to bytes. */
export function parseFootprint(output) {
  const bytes = new Map();
  for (const match of output.matchAll(/\[(\d+)\]: .*?Footprint: (\d+) B/gu)) bytes.set(Number(match[1]), Number(match[2]));
  return bytes;
}

/**
 * macOS's physical footprint per pid: dirty memory including what the system
 * compressed or swapped out. RSS drops under memory pressure; this does not.
 */
export function footprints(pids) {
  if (process.platform !== "darwin" || pids.length === 0) return undefined;
  try {
    return parseFootprint(execFileSync("footprint", ["-f", "bytes", "--noCategories", ...pids.map(String)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return undefined;
  }
}

const mib = (kib) => Math.round((kib / 1024) * 10) / 10;

/** Resident memory (and on macOS the footprint) of a process tree by role, without the fake CLI the harness itself supplies. */
export function treeMemory(roots) {
  const rows = descendants(processTable(), roots).filter((row) => processRole(row.command) !== "excluded");
  const footprint = footprints(rows.map((row) => row.pid));
  const byRole = {};
  const footprintByRole = {};
  for (const row of rows) {
    const role = processRole(row.command);
    byRole[role] = (byRole[role] ?? 0) + row.rssKiB;
    const bytes = footprint?.get(row.pid);
    if (bytes !== undefined) footprintByRole[role] = (footprintByRole[role] ?? 0) + bytes / 1024;
  }
  const totalKiB = rows.reduce((sum, row) => sum + row.rssKiB, 0);
  return {
    totalMiB: mib(totalKiB),
    processes: rows.length,
    byRoleMiB: Object.fromEntries(Object.entries(byRole).map(([role, kib]) => [role, mib(kib)])),
    ...(footprint ? {
      footprintMiB: mib(Object.values(footprintByRole).reduce((sum, kib) => sum + kib, 0)),
      footprintByRoleMiB: Object.fromEntries(Object.entries(footprintByRole).map(([role, kib]) => [role, mib(kib)])),
    } : {}),
  };
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Stops a tree by pid only: SIGTERM the roots, SIGKILL what survives the
 * grace period, then the same for every descendant recorded beforehand.
 */
export async function stopTree(roots, { graceMs = 3_000 } = {}) {
  const tree = descendants(processTable(), roots).map((row) => row.pid);
  const signal = (pids, name) => { for (const pid of pids) { try { process.kill(pid, name); } catch { /* already gone */ } } };
  signal(roots, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some(isAlive)) await wait(100);
  const survivors = tree.filter(isAlive);
  signal(survivors, "SIGKILL");
  await wait(200);
  return { stopped: tree.length, killed: survivors, stillAlive: tree.filter(isAlive) };
}
