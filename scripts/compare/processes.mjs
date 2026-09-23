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
  // Tau's host and T3's server both run as Electron-as-Node children of the main process.
  if (/dist-electron\/main\/headless\.js|apps\/server\/dist\/bin\.mjs/u.test(command)) return "backend";
  if (/Electron\.app\/Contents\/MacOS\/Electron/u.test(command)) return "main";
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
