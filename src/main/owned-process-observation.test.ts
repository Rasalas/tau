import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { processGuardian } from "./owned-process.js";

interface Simulated { parent: number; group: number; start: number; tasks: number[]; forkedFrom?: number }
const GUARDIAN = 100;
const ROOT = 200;
const DECOYS = Array.from({ length: 40 }, (_, index) => 500 + index);

/** The guardian program on a simulated Linux /proc and a manual clock; nothing real is read or signalled. */
function simulate(childrenFiles: boolean) {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; id: number; cancelled?: boolean }[] = [];
  const processes = new Map<number, Simulated>();
  const reads = { scans: 0, children: 0, stats: new Map<number, number>() };
  const signals: [number, number | string][] = [];
  const ended: (number | string)[] = [];
  const guardian = Object.assign(new EventEmitter(), { pid: GUARDIAN, platform: "linux", connected: true, env: {}, execPath: "/node", stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), send: () => true, exit: (code: number) => { ended.push(code); } });
  const root = Object.assign(new EventEmitter(), { pid: ROOT, exitCode: null as number | null, signalCode: null as string | null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const add = (pid: number, parent: number, group = pid, tasks = [pid], forkedFrom?: number) => { processes.set(pid, { parent, group, start: pid * 10, tasks, forkedFrom }); };
  const end = (pid: number) => {
    if (!processes.delete(pid)) return;
    for (const process of processes.values()) if (process.parent === pid) process.parent = 1;
    if (pid === ROOT) { root.signalCode = "SIGTERM"; root.stdout.end(); root.stderr.end(); root.emit("exit", null, "SIGTERM"); }
  };
  const fs = {
    readdirSync(path: string): string[] {
      if (path === "/proc") { reads.scans++; return ["self", "cpuinfo", ...processes.keys()].map(String); }
      const tasks = /^\/proc\/(\d+)\/task$/u.exec(path);
      if (tasks && processes.has(Number(tasks[1]))) return processes.get(Number(tasks[1]))!.tasks.map(String);
      throw missing();
    },
    readFileSync(path: string): string {
      if (/^\/proc\/self\/task\/\d+\/children$/u.test(path) && childrenFiles) return "";
      const stat = /^\/proc\/(\d+)\/stat$/u.exec(path);
      if (stat) {
        const pid = Number(stat[1]);
        reads.stats.set(pid, (reads.stats.get(pid) ?? 0) + 1);
        const process = processes.get(pid);
        if (!process) throw missing();
        return `${pid} (name (x)) S ${process.parent} ${process.group} ${process.group} 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${process.tasks.length} 0 ${process.start} 0 0`;
      }
      const children = /^\/proc\/(\d+)\/task\/(\d+)\/children$/u.exec(path);
      if (children && childrenFiles && processes.has(Number(children[1]))) {
        reads.children++;
        const [pid, task] = [Number(children[1]), Number(children[2])];
        return [...processes].filter(([, child]) => child.parent === pid && (child.forkedFrom ?? pid) === task).map(([id]) => `${id} `).join("");
      }
      throw missing();
    },
  };
  const fakeProcess = Object.assign(guardian, {
    getBuiltinModule: (name: string) => name === "fs" ? fs : name === "child_process" ? { spawn: () => { add(ROOT, GUARDIAN); return root; }, execFileSync: () => { throw missing(); } } : undefined,
    kill: (pid: number, signal: number | string) => {
      if (pid === GUARDIAN) { ended.push(signal); return true; }
      signals.push([pid, signal]);
      const targets = pid < 0 ? [...processes].filter(([, process]) => process.group === -pid).map(([id]) => id) : [pid];
      if (pid > 0 && !processes.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal !== 0) targets.forEach(end);
      return true;
    },
  });
  const setTimer = (run: () => void, delay = 0) => { const timer = { at: now + delay, run, id: timers.length }; timers.push(timer); return { unref: () => undefined, timer }; };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const sandbox = { process: fakeProcess, setTimeout: setTimer, clearTimeout: (handle?: { timer: { cancelled?: boolean } }) => { if (handle) handle.timer.cancelled = true; }, Date: { now: () => now } };
  const program = runInNewContext(`(${processGuardian.toString()})()`, sandbox) as Promise<void>;
  void program;
  fakeProcess.emit("message", { command: "/bin/work", args: [], env: {}, token: "token", retainAfterExit: false });
  return {
    add, reads, signals, ended, processes,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        await settle();
        const next = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        next.cancelled = true;
        now = Math.max(now, next.at);
        next.run();
      }
      now = until;
      await settle();
    },
    resetReads() { reads.scans = 0; reads.children = 0; reads.stats.clear(); },
    stop() { fakeProcess.emit("message", { stop: "SIGTERM" }); },
  };
}

function populate(simulation: ReturnType<typeof simulate>) {
  simulation.add(201, ROOT, ROOT, [201, 205]);
  simulation.add(202, 201);
  // Forked by the second thread of 201, in a group of its own.
  simulation.add(203, 201, 203, [203], 205);
  for (const pid of DECOYS) simulation.add(pid, 1);
}

it("follows only the known tree through its children files after the first second, and reads everything on a stop", async () => {
  const simulation = simulate(true);
  await simulation.advance(10);
  populate(simulation);
  await simulation.advance(1_500);
  expect(simulation.reads.scans).toBeGreaterThan(20);

  simulation.resetReads();
  await simulation.advance(5_000);
  expect(simulation.reads.scans).toBe(0);
  expect(DECOYS.filter((pid) => simulation.reads.stats.has(pid))).toEqual([]);
  expect(simulation.reads.children).toBeGreaterThan(0);
  // One sample a second.
  expect(simulation.reads.stats.get(ROOT)).toBeGreaterThanOrEqual(4);
  expect(simulation.reads.stats.get(ROOT)).toBeLessThanOrEqual(6);

  // A descendant of an escaped descendant, started long after the first second.
  simulation.resetReads();
  simulation.add(204, 202);
  await simulation.advance(1_000);
  expect(simulation.reads.scans).toBe(0);
  expect([...simulation.reads.stats.keys()].filter((pid) => !DECOYS.includes(pid)).sort()).toEqual([ROOT, 201, 202, 203, 204]);
  simulation.resetReads();
  simulation.stop();
  await simulation.advance(5_000);
  expect(simulation.reads.scans).toBeGreaterThan(0);
  expect([...simulation.processes.keys()].filter((pid) => !DECOYS.includes(pid))).toEqual([]);
  expect(simulation.signals.filter(([pid]) => DECOYS.includes(pid) || DECOYS.includes(-pid))).toEqual([]);
  expect(simulation.ended).toEqual(["SIGTERM"]);
});

it("reads the whole table at every sample where the kernel has no children files", async () => {
  const simulation = simulate(false);
  await simulation.advance(10);
  populate(simulation);
  await simulation.advance(1_500);
  simulation.resetReads();
  await simulation.advance(3_000);
  expect(simulation.reads.scans).toBeGreaterThanOrEqual(2);
  expect(simulation.reads.children).toBe(0);
});
