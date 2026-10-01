import { describe, expect, it } from "vitest";
import { appendHistory, evaluateBuildTime, measureReference, median, referenceWorkload } from "./build-time.mjs";
import { evaluateBuildBudgets } from "./build-report.mjs";

const CAP = 30_000;
const config = { referenceMs: 1000, minSpeedFactor: 0.5, historyEpoch: 1, historyRuns: 20, historyMinRuns: 5, historyMargin: 0.2 };
// Two regions of the same runner type: the second does every step about 40 % slower.
const FAST = 1000;
const SLOW = 1400;
const mainRuns = [
  [23_000, FAST], [32_200, SLOW], [22_600, FAST], [31_640, SLOW], [23_400, FAST], [32_760, SLOW],
].map(([buildTimeMs, referenceMs]) => ({ epoch: 1, buildTimeMs, referenceMs }));

const check = (buildTimeMs, referenceMs, history = []) => evaluateBuildTime({ buildTimeMs, referenceMs }, CAP, config, history);

describe("build time relative to the machine", () => {
  it("holds a build without a reference measurement to the raw budget", () => {
    expect(check(29_000, undefined).failures).toEqual([]);
    expect(check(31_000, undefined).failures).toEqual(["buildTimeMs 31000 > budget 30000"]);
    expect(evaluateBuildTime({ buildTimeMs: 31_000, referenceMs: 900 }, CAP, undefined).failures).toHaveLength(1);
  });

  it("passes the same build on a slower runner that the raw budget would fail", () => {
    const result = check(32_000, SLOW);
    expect(result.failures).toEqual([]);
    expect(result.summary).toMatchObject({ normalizedMs: 22_857, cappedMs: 22_857, speedFactor: 0.714 });
  });

  it("never holds a faster machine to more than the raw budget, nor less", () => {
    expect(check(29_000, 500).failures).toEqual([]);
    expect(check(31_000, 500).failures).toHaveLength(1);
    expect(check(31_000, 500).summary.normalizedMs).toBe(62_000);
  });

  it("bounds the credit a slow or disturbed reference can give", () => {
    expect(check(59_000, 5000).failures).toEqual([]);
    expect(check(61_000, 5000).failures[0]).toMatch(/^buildTimeMs 61000 is 30500 at reference speed > budget 30000/u);
  });

  it("fails 30 % more real work on either runner once there is history, though the cap still passes it", () => {
    expect(check(23_200, FAST, mainRuns).failures).toEqual([]);
    expect(check(32_400, SLOW, mainRuns).failures).toEqual([]);
    const slowRegion = check(Math.round(32_200 * 1.3), SLOW, mainRuns);
    expect(slowRegion.summary.cappedMs).toBeLessThan(CAP);
    expect(slowRegion.failures).toEqual([
      "buildTimeMs at reference speed 29900 > 27600, the median of the last 6 main runs (23000) + 20%",
    ]);
    expect(check(Math.round(23_000 * 1.3), FAST, mainRuns).failures).toHaveLength(1);
    expect(check(23_000, FAST, mainRuns).summary.history).toEqual({ runs: 6, medianMs: 23_000, limitMs: 27_600 });
  });

  it("uses only enough recent runs of the current epoch", () => {
    const regressed = Math.round(23_000 * 1.3);
    expect(check(regressed, FAST, mainRuns.slice(0, 4)).failures).toEqual([]);
    expect(check(regressed, FAST, mainRuns.map((run) => ({ ...run, epoch: 0 }))).summary.history).toBeNull();
    const older = Array.from({ length: 20 }, () => ({ epoch: 1, buildTimeMs: 15_000, referenceMs: FAST }));
    expect(check(23_000, FAST, [...older, ...mainRuns]).summary.history.medianMs).toBe(15_000);
    expect(check(23_000, FAST, [...mainRuns, ...older]).failures).toHaveLength(1);
  });

  it("re-reads history at the current runner reference, so recalibrating keeps the runs", () => {
    const recalibrated = { ...config, referenceMs: 2000 };
    const result = evaluateBuildTime({ buildTimeMs: 23_000, referenceMs: FAST }, CAP, recalibrated, mainRuns);
    expect(result.summary.history.medianMs).toBe(46_000);
    expect(result.failures).toEqual([]);
  });

  it("keeps the newest runs of the current epoch", () => {
    const history = [{ epoch: 0, buildTimeMs: 1 }, ...Array.from({ length: 20 }, (_, index) => ({ epoch: 1, buildTimeMs: index }))];
    const next = appendHistory(history, { buildTimeMs: 99, referenceMs: 1 }, config);
    expect(next).toHaveLength(20);
    expect(next[0].buildTimeMs).toBe(1);
    expect(next.at(-1)).toEqual({ buildTimeMs: 99, referenceMs: 1, epoch: 1 });
  });

  it("feeds the cap and the trend into the build budget", () => {
    const report = {
      initial: { javascript: { bytes: 1, gzipBytes: 1 }, css: { bytes: 1, gzipBytes: 1 } },
      lazy: { javascript: { bytes: 1, gzipBytes: 1 } },
      buildTimeMs: 32_000,
      buildTime: { referenceMs: SLOW },
      overlayComposition: { backdropBlur: false },
    };
    const budgets = { buildTimeMs: CAP, buildTimeReference: config };
    expect(evaluateBuildBudgets(report, budgets)).toEqual([]);
    expect(evaluateBuildBudgets({ ...report, buildTimeMs: 42_000 }, budgets, mainRuns)).toHaveLength(1);
    expect(evaluateBuildBudgets({ ...report, buildTime: undefined }, budgets)).toEqual(["buildTimeMs 32000 > budget 30000"]);
  });

  it("runs a deterministic workload and times each sample after a warm-up", () => {
    expect(referenceWorkload(500)).toBe(referenceWorkload(500));
    let runs = 0;
    expect(measureReference({ samples: 3, workload: () => { runs += 1; } })).toHaveLength(3);
    expect(runs).toBe(4);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
