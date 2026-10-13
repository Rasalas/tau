import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTED_LOG, cleanSmoke, describeCleanup, displayLeftovers, parseProcStat, procStat, readStarted, stopStarted } from "./smoke-processes.mjs";

/** A process table and /tmp; a signal to a group reaches its members, and `stubborn` ones ignore SIGTERM. */
function machine({ processes = {}, files = {}, stubborn = [] } = {}) {
  const signals = [];
  const probe = {
    stat: (pid) => processes[pid],
    pids: () => Object.keys(processes).map(Number),
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
  it.skipIf(process.platform !== "linux")("repeatedly stops a real orphan that keeps writing into HOME", async () => {
    const writer = `
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      process.on('SIGTERM', () => {});
      const write = () => writeFileSync(join(process.env.HOME, 'writer.ready'), String(Date.now()));
      write(); setInterval(write, 1);
    `;
    const parent = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' });
      writeFileSync(join(process.env.HOME, 'writer.pid'), String(child.pid));
      setInterval(() => {}, 1000);
    `;
    for (let run = 0; run < 3; run++) {
      const home = mkdtempSync(join(tmpdir(), "tau-display-smoke-home-test-"));
      const leader = spawn(process.execPath, ["-e", parent], { env: { ...process.env, HOME: home }, stdio: "ignore", detached: true });
      const exited = new Promise((resolve) => leader.once("close", resolve));
      let child;
      try {
        await expect.poll(() => existsSync(join(home, "writer.ready")) && existsSync(join(home, "writer.pid"))).toBe(true);
        const pid = Number(readFileSync(join(home, "writer.pid"), "utf8"));
        child = { pid, startTime: procStat(pid)?.startTime };
        const started = [{ unit: "window", pid: leader.pid, startTime: procStat(leader.pid)?.startTime }];
        leader.kill("SIGTERM");
        await exited;
        const report = cleanSmoke({ started, directories: [home], graceMs: 100 });
        expect(report.remaining).toEqual([]);
        expect(procStat(pid)?.state ?? "Z").toBe("Z");
        expect(existsSync(home)).toBe(false);
      } finally {
        leader.kill("SIGKILL");
        await exited;
        if (!child && existsSync(join(home, "writer.pid"))) {
          const pid = Number(readFileSync(join(home, "writer.pid"), "utf8"));
          child = { pid, startTime: procStat(pid)?.startTime };
        }
        if (child && child.startTime !== undefined && procStat(child.pid)?.startTime === child.startTime) {
          try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
        }
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  });

  it("stops group members after their recorded leader has already exited", () => {
    const system = machine({ processes: { 101: { state: "S", pgrp: 100, startTime: 60 } } });
    stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], ...system });
    expect(system.probe.stat(101).state).toBe("Z");
  });

  it("kills a stubborn child even when SIGTERM has stopped its leader", () => {
    const system = machine({ processes: {
      100: { state: "S", pgrp: 100, startTime: 50 },
      101: { state: "S", pgrp: 100, startTime: 60 },
    }, stubborn: [101] });
    stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], ...system, graceMs: 100 });
    expect(system.probe.stat(101).state).toBe("Z");
  });

  it("stops detached orphans with the smoke's HOME or profile path", () => {
    const home = "/tmp/tau-display-smoke-home-test";
    const userData = "/tmp/tau-display-smoke-userdata-test";
    const system = machine({ processes: {
      101: { state: "S", pgrp: 101, startTime: 60 },
      102: { state: "S", pgrp: 102, startTime: 61 },
      900: { state: "S", pgrp: 900, startTime: 1 },
    }, files: {
      "/proc/101/environ": `HOME=${home}\0`,
      "/proc/102/cmdline": `crash-handler\0--database=${userData}/Crashpad\0`,
      "/proc/900/environ": `HOME=${home}-foreign\0`,
    } });
    stopStarted({ started: [], directories: [home, userData], ...system });
    expect(system.probe.stat(101).state).toBe("Z");
    expect(system.probe.stat(102).state).toBe("Z");
    expect(system.probe.stat(900).state).toBe("S");
  });

  it("leaves a reused leader's new process group alone", () => {
    const system = machine({ processes: {
      100: { state: "S", pgrp: 100, startTime: 999 },
      101: { state: "S", pgrp: 100, startTime: 1000 },
    } });
    stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], ...system });
    expect(system.signals).toEqual([]);
  });

  it("waits for SIGKILL to take effect and reports a process that cannot be stopped", () => {
    const system = machine({ processes: { 100: { state: "S", pgrp: 100, startTime: 50 } } });
    let killed = false;
    let waited = false;
    const report = stopStarted({
      started: [{ unit: "window", pid: 100, startTime: 50 }], probe: system.probe, graceMs: 0,
      kill: (_pid, signal) => { killed ||= signal === "SIGKILL"; },
      sleep: () => { waited ||= killed; },
    });
    expect(waited).toBe(true);
    expect(report.remaining.map(({ pid }) => pid)).toEqual([100]);
    expect(report.stopped).toEqual([]);
  });


  it("follows descendants that leave the group and remembers them after reparenting", () => {
    const processes = {
      100: { state: "S", pgrp: 100, startTime: 50 },
      101: { state: "S", pgrp: 101, ppid: 100, startTime: 60 },
      102: { state: "S", pgrp: 102, ppid: 101, startTime: 61 },
    };
    const system = machine({ processes, stubborn: [101, 102] });
    const report = stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], ...system,
      graceMs: 100, sleep: () => { processes[101].ppid = 1; processes[102].ppid = 1; },
    });
    expect(report.remaining).toEqual([]);
    expect(processes[102].state).toBe("Z");
  });

  it("discovers a detached writer forked during shutdown", () => {
    const home = "/tmp/tau-display-smoke-home-test";
    const processes = { 100: { state: "S", pgrp: 100, startTime: 50 } };
    const system = machine({ processes, stubborn: [100] });
    let spawned = false;
    stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], directories: [home], ...system,
      graceMs: 100, sleep: () => {
        if (spawned) return;
        spawned = true;
        processes[101] = { state: "S", pgrp: 101, startTime: 60 };
        system.files["/proc/101/environ"] = `HOME=${home}\0`;
      },
    });
    expect(processes[101].state).toBe("Z");
  });

  it("does not signal a PID reused between discovery and signaling", () => {
    const processes = {
      100: { state: "S", pgrp: 100, startTime: 50 },
      101: { state: "S", pgrp: 100, startTime: 60 },
    };
    const system = machine({ processes });
    stopStarted({ started: [{ unit: "window", pid: 100, startTime: 50 }], ...system,
      kill: (pid, signal) => {
        system.kill(pid, signal);
        if (pid === 100) processes[101] = { state: "S", pgrp: 101, startTime: 999 };
      },
    });
    expect(system.signals).toEqual([[100, "SIGTERM"]]);
    expect(processes[101].state).toBe("S");
  });

  it("diagnoses ENOTEMPTY without failing cleanup when no smoke process lives", () => {
    const logs = [];
    const removed = [];
    const report = cleanSmoke({ started: [], directories: ["/tmp/profile", "/tmp/home"], ...machine(),
      removeDirectory: (path) => {
        removed.push(path);
        if (path === "/tmp/profile") throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" });
      },
      list: () => ["Crashpad", "Crashpad/settings.dat"], log: (line) => logs.push(line),
    });
    expect(report.remaining).toEqual([]);
    expect(removed).toEqual(["/tmp/profile", "/tmp/home"]);
    expect(logs[0]).toContain("ENOTEMPTY");
    expect(logs[0]).toContain("Crashpad/settings.dat");
    expect(logs[0]).toContain("live smoke processes: none");
  });

  it("reports live writers even with KEEP or successful deletion", () => {
    for (const keep of [false, true]) {
      const system = machine({ processes: { 101: { state: "S", pgrp: 101, startTime: 60 } },
        files: { "/proc/101/environ": "HOME=/tmp/home\0", "/proc/101/comm": "crash-handler\n" },
      });
      const report = cleanSmoke({ started: [], directories: ["/tmp/home"], ...system, keep,
        kill: () => { throw new Error("EPERM"); }, graceMs: 0, killWaitMs: 0, removeDirectory: () => undefined,
      });
      expect(report.remaining.map(({ pid }) => pid)).toEqual([101]);
      expect(describeCleanup(report).join("\n")).toContain("crash-handler pid 101");
    }
  });

  it("names a live writer on deletion failure without exposing its environment", () => {
    const logs = [];
    const system = machine({ processes: { 101: { state: "S", pgrp: 101, startTime: 60 } },
      files: { "/proc/101/environ": "HOME=/tmp/home\0PRIVATE_KEY=secret\0", "/proc/101/comm": "crash-handler\n" },
    });
    const report = cleanSmoke({ started: [], directories: ["/tmp/home"], ...system,
      kill: () => undefined, graceMs: 0, killWaitMs: 0,
      removeDirectory: () => { throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" }); },
      list: () => ["Crashpad/settings.dat"], log: (line) => logs.push(line),
    });
    expect(report.remaining.map(({ pid }) => pid)).toEqual([101]);
    expect(logs[0]).toContain("crash-handler pid 101");
    expect(logs[0]).not.toContain("PRIVATE_KEY");
    expect(logs[0]).not.toContain("secret");
  });

  it("reads a stat line whose command has spaces and parentheses", () => {
    const line = "4242 (Xvfb (a) b) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 12345 67 18446744073709551615";
    expect(parseProcStat(line)).toEqual({ state: "S", ppid: 1, pgrp: 4242, startTime: 987654 });
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

  it("stops only its own, including group members, and SIGKILLs what ignores SIGTERM", () => {
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

    expect(system.signals).toEqual([[100, "SIGTERM"], [101, "SIGTERM"], [200, "SIGTERM"], [200, "SIGKILL"]]);
    expect(report.stopped).toEqual([
      { unit: "tau-xvfb-1.service", pid: 100, signal: "SIGTERM" },
      { unit: "tau-xvfb-1.service", pid: 101, signal: "SIGTERM" },
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
