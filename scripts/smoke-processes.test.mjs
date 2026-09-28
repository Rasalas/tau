import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTED_LOG, describeCleanup, displayLeftovers, parseProcStat, readStarted, stopStarted } from "./smoke-processes.mjs";

/** A process table and /tmp; a signal to a group reaches its members, and `stubborn` ones ignore SIGTERM. */
function machine({ processes = {}, files = {}, stubborn = [] } = {}) {
  const signals = [];
  const probe = {
    stat: (pid) => processes[pid],
    readFile: (path) => files[path],
    exists: (path) => path in files,
  };
  const kill = (target, signal) => {
    signals.push([target, signal]);
    const members = target < 0 ? Object.keys(processes).map(Number).filter((pid) => processes[pid].pgrp === -target) : [target];
    if (members.length === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    for (const pid of members) if (signal === "SIGKILL" || !stubborn.includes(pid)) processes[pid] = { ...processes[pid], state: "Z" };
  };
  const remove = (path) => { delete files[path]; };
  return { probe, kill, remove, signals, files, sleep: () => undefined };
}

describe("the processes a smoke started", () => {
  it("reads a stat line whose command has spaces and parentheses", () => {
    const line = "4242 (Xvfb (a) b) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 12345 67 18446744073709551615";
    expect(parseProcStat(line)).toEqual({ state: "S", pgrp: 4242, startTime: 987654 });
  });

  it("reads the fake's started log and skips a torn line", () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-started-"));
    try {
      writeFileSync(join(directory, STARTED_LOG), `${JSON.stringify({ unit: "tau-xvfb-1.service", pid: 10, startTime: 5 })}\n{"unit":"tau-ho`);
      expect(readStarted(directory)).toEqual([{ unit: "tau-xvfb-1.service", pid: 10, startTime: 5 }]);
      expect(readStarted(join(directory, "missing"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops only its own, by group, and SIGKILLs what ignores SIGTERM", () => {
    const started = [
      { unit: "tau-xvfb-1.service", pid: 100, startTime: 50 },
      { unit: "tau-host-1.service", pid: 200, startTime: 51 },
      { unit: "tau-window-1.service", pid: 300, startTime: 52 },
      { unit: "tau-window-1.service", pid: 400, startTime: 53 },
      { unit: "tau-host-1.service", pid: 500, startTime: 54 },
    ];
    const system = machine({
      processes: {
        100: { state: "S", pgrp: 100, startTime: 50 },
        101: { state: "S", pgrp: 100, startTime: 60 },
        200: { state: "S", pgrp: 200, startTime: 51 },
        // Exited and its pid reused by someone else's process.
        300: { state: "S", pgrp: 300, startTime: 999 },
        // A zombie under an init that never reaps.
        400: { state: "Z", pgrp: 400, startTime: 53 },
        // Someone else's Xvfb on another display.
        900: { state: "S", pgrp: 900, startTime: 1 },
      },
      stubborn: [200],
    });
    const report = stopStarted({ started, probe: system.probe, kill: system.kill, remove: system.remove, sleep: system.sleep, graceMs: 300 });

    expect(system.signals).toEqual([[-100, "SIGTERM"], [-200, "SIGTERM"], [-200, "SIGKILL"]]);
    expect(report.stopped).toEqual([
      { unit: "tau-xvfb-1.service", pid: 100, signal: "SIGTERM" },
      { unit: "tau-host-1.service", pid: 200, signal: "SIGKILL" },
    ]);
    expect(report.gone.map((entry) => entry.pid)).toEqual([300, 400, 500]);
    expect(describeCleanup(report)).toContain("stopped tau-host-1.service pid 200 (SIGKILL)");
  });

  it("signals a leader outside its own group alone", () => {
    const system = machine({ processes: { 100: { state: "S", pgrp: 1, startTime: 50 } } });
    stopStarted({ started: [{ unit: "u", pid: 100, startTime: 50 }], probe: system.probe, kill: system.kill, sleep: system.sleep });
    expect(system.signals).toEqual([[100, "SIGTERM"]]);
  });

  it("removes the display's lock and socket only when its own Xvfb held them", () => {
    const ours = [{ unit: "tau-xvfb-1.service", pid: 100, startTime: 50 }];
    const lock = "/tmp/.X101-lock";
    const socket = "/tmp/.X11-unix/X101";
    const gone = { stat: () => undefined, readFile: (path) => (path === lock ? "       100\n" : undefined), exists: () => true };
    expect(displayLeftovers(101, ours, gone)).toEqual({ remove: [lock, socket], kept: [] });
    const running = { ...gone, stat: () => ({ state: "S", pgrp: 100, startTime: 50 }) };
    expect(displayLeftovers(101, ours, running)).toEqual({ remove: [], kept: [{ path: lock, reason: "its Xvfb (pid 100) still runs" }] });
    const foreign = { ...gone, readFile: () => "777\n" };
    expect(displayLeftovers(101, ours, foreign)).toEqual({ remove: [], kept: [{ path: lock, reason: "held by pid 777, which the smoke did not start" }] });
    const socketOnly = { ...gone, exists: (path) => path === socket };
    expect(displayLeftovers(101, ours, socketOnly)).toEqual({ remove: [], kept: [{ path: socket, reason: "no lock names its owner" }] });
    expect(displayLeftovers(101, ours, { ...gone, exists: () => false })).toEqual({ remove: [], kept: [] });

    // SIGKILLed, an Xvfb leaves both behind; the cleanup takes them.
    const system = machine({
      processes: { 100: { state: "S", pgrp: 100, startTime: 50 } },
      files: { [lock]: "100\n", [socket]: "", "/tmp/.X99-lock": "12\n" },
      stubborn: [100],
    });
    const report = stopStarted({ started: ours, display: 101, probe: system.probe, kill: system.kill, remove: system.remove, sleep: system.sleep, graceMs: 100 });
    expect(report.removed).toEqual([lock, socket]);
    expect(Object.keys(system.files)).toEqual(["/tmp/.X99-lock"]);
    expect(describeCleanup({ stopped: [], gone: [], removed: [], kept: [] })).toEqual(["nothing to clean up"]);
  });
});
