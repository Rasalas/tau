import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, evaluateBuildTime, measureBuildWithRetry, measureReference, median, referenceWorkload } from "./build-time.mjs";
import { checkBuildTime, collectBuildReport, describeBuildTime, evaluateBuildBudgets } from "./build-report.mjs";

const CAP = 30_000;
const config = { referenceMs: 1000, minSpeedFactor: 0.5, historyEpoch: 1, historyRuns: 20, historyMinRuns: 5, historyMargin: 0.2 };
// Two regions of the same runner type: the second does every step about 40 % slower.
const FAST = 1000;
const SLOW = 1400;
const mainRuns = [
  [23_000, FAST], [32_200, SLOW], [22_600, FAST], [31_640, SLOW], [23_400, FAST], [32_760, SLOW],
].map(([buildTimeMs, referenceMs]) => ({ epoch: 1, buildTimeMs, referenceMs }));

const check = (buildTimeMs, referenceMs, history = []) => evaluateBuildTime({ buildTimeMs, referenceMs }, CAP, config, history);

describe("build time confirmation", () => {
  const history = Array.from({ length: 20 }, () => ({ epoch: 1, buildTimeMs: 20_000, referenceMs: FAST }));
  const sample = (buildTimeMs, referenceMs = FAST) => ({ buildTimeMs, referenceSamplesMs: [referenceMs] });
  const evaluate = (measurement) => check(measurement.buildTimeMs, median(measurement.referenceSamplesMs), history);

  it("passes a single measurement just over the trend limit after one successful retry", async () => {
    const slow = sample(24_002);
    const normal = sample(20_000);
    const measure = vi.fn().mockResolvedValueOnce(slow).mockResolvedValueOnce(normal);
    const result = await measureBuildWithRetry(measure, CAP, config, history);
    expect(evaluate(result).failures).toEqual([]);
    expect(result.buildTimeAttempts).toEqual([slow, normal]);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it.each([25_000, 27_000])("keeps a sustained slowdown red after exactly one retry at %s ms", async (retryMs) => {
    const slow = sample(26_000);
    const retry = sample(retryMs);
    const measure = vi.fn().mockResolvedValueOnce(slow).mockResolvedValueOnce(retry);
    const result = await measureBuildWithRetry(measure, CAP, config, history);
    expect(evaluate(result).failures).toHaveLength(1);
    expect(result.buildTimeMs).toBe(Math.min(26_000, retryMs));
    expect(result.buildTimeAttempts).toEqual([slow, retry]);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a build that passes on its first measurement", async () => {
    const normal = sample(20_000);
    const measure = vi.fn().mockResolvedValue(normal);
    const result = await measureBuildWithRetry(measure, CAP, config, history);
    expect(result.buildTimeAttempts).toEqual([normal]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary build without a time budget at one attempt", async () => {
    const measure = vi.fn().mockResolvedValue({ buildTimeMs: 100_000, referenceSamplesMs: [] });
    await measureBuildWithRetry(measure);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it.each([20_000, 32_000])("confirms an absolute cap violation without history, retry %s ms", async (retryMs) => {
    const measure = vi.fn().mockResolvedValueOnce(sample(31_000)).mockResolvedValueOnce(sample(retryMs));
    const result = await measureBuildWithRetry(measure, CAP, config);
    expect(check(result.buildTimeMs, median(result.referenceSamplesMs)).failures).toHaveLength(retryMs > CAP ? 1 : 0);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("uses a passing retry with a slower raw time and its own slower reference", async () => {
    const slow = sample(26_000);
    const normal = sample(28_000, SLOW);
    const measure = vi.fn().mockResolvedValueOnce(slow).mockResolvedValueOnce(normal);
    const result = await measureBuildWithRetry(measure, CAP, config, history);
    expect(result.buildTimeMs).toBe(28_000);
    expect(result.referenceSamplesMs).toEqual([SLOW]);
    expect(evaluate(result).failures).toEqual([]);
  });

  it("propagates a failed retry instead of accepting an incomplete build", async () => {
    const measure = vi.fn().mockResolvedValueOnce(sample(26_000)).mockRejectedValueOnce(new Error("build failed"));
    await expect(measureBuildWithRetry(measure, CAP, config, history)).rejects.toThrow("build failed");
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("keeps both attempts in the asset report and log while gating the selected measurement", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "tau-build-time-")));
    try {
      await writeFile(join(directory, "index.html"), "<html></html>");
      const kitsDirectory = join(directory, "kits");
      await mkdir(kitsDirectory);
      const attempts = [sample(24_002), sample(20_000, 1100)];
      const measure = vi.fn().mockResolvedValueOnce(attempts[0]).mockResolvedValueOnce(attempts[1]);
      const measurement = await measureBuildWithRetry(measure, CAP, config, history);
      const report = await collectBuildReport(directory, { ...measurement, kitsDirectory });
      const budgets = { buildTimeMs: CAP, buildTimeReference: config };
      expect(report.buildTimeAttempts).toEqual(attempts);
      expect(report.buildTimeMs).toBe(20_000);
      expect(report.buildTime.referenceMs).toBe(1100);
      expect(evaluateBuildBudgets(report, budgets, history)).toEqual([]);
      expect(evaluateBuildBudgets(report, { ...budgets, initialJavascriptBytes: -1 }, history)).toEqual([
        "initial.javascript.bytes 0 > budget -1",
      ]);
      Object.assign(report.buildTime, checkBuildTime(report, budgets, history).summary);
      const log = describeBuildTime(report);
      expect(log).toContain("Build time: 20000 ms raw");
      expect(log).toContain("#1 24002 ms raw, reference samples 1000 ms");
      expect(log).toContain("#2 20000 ms raw, reference samples 1100 ms");

      await Promise.all(["scripts", "reports", "dist", "src/renderer"].map((folder) => mkdir(join(directory, folder), { recursive: true })));
      await Promise.all(["build-report.mjs", "build-time.mjs"].map(async (script) => {
        await writeFile(join(directory, "scripts", script), await readFile(new URL(script, import.meta.url)));
      }));
      await writeFile(join(directory, "scripts/performance-budgets.json"), JSON.stringify(budgets));
      await writeFile(join(directory, "dist/index.html"), "<html></html>");
      await writeFile(join(directory, "src/renderer/styles.css"), "");
      const reportPath = join(directory, "reports/build-report.json");
      const historyPath = join(directory, "history.json");
      const summaryPath = join(directory, "summary.md");
      await writeFile(reportPath, JSON.stringify(report));
      await writeFile(historyPath, JSON.stringify(history));
      const env = { ...process.env, TAU_DIST: "dist", TAU_BUILD_TIME_MS: "", TAU_BUILD_REFERENCE_MS: "",
        TAU_BUILD_TIME_HISTORY: historyPath, GITHUB_STEP_SUMMARY: summaryPath };
      const output = execFileSync(process.execPath, [join(directory, "scripts/build-report.mjs"), "--check"], { env, encoding: "utf8" });
      expect(output).toContain("#1 24002 ms raw");
      expect(output).toContain("#2 20000 ms raw");
      expect(await readFile(summaryPath, "utf8")).toContain("#1 24002 ms raw");
      expect(JSON.parse(await readFile(reportPath, "utf8")).buildTimeAttempts).toEqual(attempts);
      execFileSync(process.execPath, [join(directory, "scripts/build-time.mjs"), "record", historyPath], { env, encoding: "utf8" });
      expect(JSON.parse(await readFile(historyPath, "utf8")).at(-1)).toMatchObject({ buildTimeMs: 20_000, referenceMs: 1100 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

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

  it.each([1.5, 1.6])("passes an unchanged build when only the reference speeds up by %s", (speed) => {
    const result = check(23_000, FAST / speed, mainRuns);
    expect(result.summary.normalizedMs).toBeGreaterThan(result.summary.history.limitMs);
    expect(result.failures).toEqual([]);
  });

  it("still rejects an injected slowdown with a fast reference", () => {
    const history = Array.from({ length: 20 }, () => ({ epoch: 1, buildTimeMs: 20_000, referenceMs: FAST }));
    const result = check(26_000, FAST / 1.6, history);
    expect(result.summary.cappedMs).toBeLessThan(CAP);
    expect(result.failures).toHaveLength(1);
  });

  it("does not reject a raw increase explained by a slower runner", () => {
    const history = Array.from({ length: 20 }, () => ({ epoch: 1, buildTimeMs: 23_000, referenceMs: FAST }));
    expect(check(32_200, SLOW, history).failures).toEqual([]);
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
      "buildTimeMs at reference speed 29900 > 27600, the median of the last 6 main runs (23000) + 20%; raw 41860 > 33024 (median 27520)",
    ]);
    const fastRuns = mainRuns.filter((run) => run.referenceMs === FAST);
    expect(check(Math.round(23_000 * 1.3), FAST, [...fastRuns, ...fastRuns]).failures).toHaveLength(1);
    expect(check(23_000, FAST, mainRuns).summary.history).toEqual({ runs: 6, medianMs: 23_000, limitMs: 27_600, rawMedianMs: 27_520, rawLimitMs: 33_024 });
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
