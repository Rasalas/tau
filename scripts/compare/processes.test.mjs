import { describe, expect, it } from "vitest";
import { cpuDelta, measureIdleCpu, parseCpuPs, parseCpuTime } from "./processes.mjs";

const main = "/x/Electron.app/Contents/MacOS/Electron .";
const backend = "/x/Electron.app/Contents/MacOS/Electron /x/dist-electron/main/headless.js";
const renderer = "/x/helper --type=renderer";
const row = (pid, ppid, cpuMs, command, started = "Mon Oct 12 10:00:00 2026") => ({ pid, ppid, cpuMs, command, started });

describe("idle CPU time", () => {
  it("reads cumulative macOS and Linux CPU times, including hours and days", () => {
    expect(parseCpuTime("0:01.23")).toBe(1230);
    expect(parseCpuTime("02:03:04")).toBe(7_384_000);
    expect(parseCpuTime("1-02:03:04.50")).toBe(93_784_500);
    expect(() => parseCpuTime("bad")).toThrow();
    expect(parseCpuPs(` 10 1 0:01.23 Mon Oct 12 10:00:00 2026 ${main}\n`)).toEqual([row(10, 1, 1230, main)]);
    expect(parseCpuPs(` 10 1 00:01:23 Mon Oct  5 10:00:00 2026 ${main}\n`)[0]).toMatchObject({ cpuMs: 83000, started: "Mon Oct 5 10:00:00 2026" });
  });

  it("sums only the app tree by role, excludes the replay CLI and normalizes to one core", () => {
    const before = [row(10, 1, 1000, main), row(11, 10, 2000, backend), row(12, 10, 3000, renderer), row(13, 11, 4000, "node fake-codex.mjs"), row(20, 1, 5000, main)];
    const after = before.map((entry) => ({ ...entry, cpuMs: entry.cpuMs + entry.pid * 10 }));
    const delta = cpuDelta(before, after, [10], 2000);
    expect(delta).toMatchObject({ complete: true, windowMs: 2000, totalMs: 330, totalPercent: 16.5, byRoleMs: { main: 100, backend: 110, renderer: 120 }, byRolePercent: { main: 5, backend: 5.5, renderer: 6 } });
  });

  it("marks churn, PID reuse, missing roots and regressed counters as incomplete", () => {
    const before = [row(10, 1, 1000, main), row(11, 10, 2000, renderer)];
    for (const after of [before.slice(0, 1), [...before, row(12, 10, 0, backend)], [before[0], row(11, 10, 2010, renderer, "Tue Oct 13 10:00:00 2026")], [before[0], row(11, 10, 1990, renderer)], []]) {
      expect(cpuDelta(before, after, [10], 1000)).toMatchObject({ complete: false, totalMs: null, totalPercent: null });
    }
    expect(cpuDelta([], [], [10], 1000).complete).toBe(false);
  });

  it("samples around an idle window using actual elapsed time", async () => {
    const samples = [[row(10, 1, 1000, main)], [row(10, 1, 1100, main)]];
    const times = [0, 1250];
    const waits = [];
    const result = await measureIdleCpu([10], 1000, { readTable: () => samples.shift(), now: () => times.shift(), wait: async (ms) => waits.push(ms) });
    expect(waits).toEqual([1000]);
    expect(result).toMatchObject({ windowMs: 1250, totalMs: 100, totalPercent: 8 });
  });
});
