import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { benchmarkElectron, comparePerformanceReports, comparisonPolicy, rendererHarnessFiles } from "./performance-comparison.mjs";

function fixture() {
  const provenance = { baseCommit: "a".repeat(40), headCommit: "b".repeat(40), harnessSha256: "c".repeat(64), seriesId: "test-series", measurementRuntime: { sourceCommit: "b".repeat(40), electronVersion: "44.4.4", executable: join(import.meta.dirname, "head electron"), binarySha256: "1".repeat(64) } };
  const runs = Array.from({ length: comparisonPolicy.pairs }, (_, round) => ["base", "head"].map((side) => ({
    round, side, harnessSha256: provenance.harnessSha256, seriesId: provenance.seriesId,
    starts: Array.from({ length: 3 }, () => ({ schemaVersion: 1, measurement: "renderer-bundle-fixture", firstPaintMs: 100, externalRequests: [], execution: { profileMode: "fresh-per-process", electronVersion: "44.4.4", electronExecutable: provenance.measurementRuntime.executable } })),
    renderer: {
      schemaVersion: 2, commitSha: provenance[`${side}Commit`],
      machine: { chip: "test-cpu", platform: "linux", logicalCores: 4 },
      startConditions: { warmupRuns: 1, sampleRuns: 3, viewport: "1440x900", throttle: "none" },
      harnessSourceSha256: "d".repeat(64), harnessFileSha256: Object.fromEntries(rendererHarnessFiles.map((file) => [file, "e".repeat(64)])), buildArtifactSha256: "f".repeat(64),
      execution: { electronVersion: "44.4.4", electronExecutable: provenance.measurementRuntime.executable, profileMode: "fresh-per-process", parallelRuns: 1, gpu: { mode: "default", featureStatus: { gpu_compositing: "disabled_software" }, info: { auxAttributes: { initializationTime: round + (side === "head" ? 0.5 : 0) } } } },
      scenarios: comparisonPolicy.scenarios.map((id) => ({
        id, fixture: { id, bytes: 153600 }, sampleRuns: 3,
        ...Object.fromEntries(Object.keys(comparisonPolicy.rendererMetrics).map((metric) => [metric, { median: 20, p95: 20 }])),
        rawSamples: Array.from({ length: 3 }, () => Object.fromEntries(Object.keys(comparisonPolicy.rendererMetrics).map((metric) => [metric, [20, 20, 20]]))),
      })),
    },
  }))).flat();
  return { runs, provenance };
}

describe("paired performance comparison", () => {
  it("selects one absolute Electron executable for both subjects", () => {
    const baseRoot = join(import.meta.dirname, "base");
    const headRoot = join(import.meta.dirname, "head");
    const executable = join(headRoot, "Electron with spaces");
    const env = { TAU_BENCHMARK_ELECTRON: executable };
    expect(benchmarkElectron(baseRoot, env)).toBe(executable);
    expect(benchmarkElectron(headRoot, env)).toBe(executable);
    expect(benchmarkElectron(baseRoot, {})).toBe(join(baseRoot, "node_modules", ".bin", "electron"));
    expect(() => benchmarkElectron(baseRoot, { TAU_BENCHMARK_ELECTRON: "relative/electron" })).toThrow(/absolute/u);
  });

  it("rejects a consistent but unexpected runtime instead of attributing it to product changes", () => {
    const { runs, provenance } = fixture();
    for (const run of runs) {
      run.renderer.execution.electronVersion = "44.10.0";
      for (const start of run.starts) start.execution.electronVersion = "44.10.0";
    }
    expect(() => comparePerformanceReports(runs, provenance)).toThrow("Invalid performance comparison:");
  });

  it.each([
    ["missing runtime", (runtime, provenance) => { delete provenance.measurementRuntime; }],
    ["wrong runtime source", (runtime) => { runtime.sourceCommit = "0".repeat(40); }],
    ["missing runtime fingerprint", (runtime) => { delete runtime.binarySha256; }],
  ])("rejects %s provenance", (_label, mutate) => {
    const { runs, provenance } = fixture();
    mutate(provenance.measurementRuntime, provenance);
    expect(() => comparePerformanceReports(runs, provenance)).toThrow("Invalid performance comparison:");
  });

  it("accepts unchanged timings despite volatile GPU initialization timings", () => {
    const { runs, provenance } = fixture();
    expect(comparePerformanceReports(runs, provenance).failures).toEqual([]);
  });

  it("blocks a repeatable material renderer and first-paint regression", () => {
    const { runs, provenance } = fixture();
    for (const run of runs.filter((candidate) => candidate.side === "head")) {
      run.renderer.scenarios[0].updateDurationsMs.p95 = 30;
      for (const start of run.starts) start.firstPaintMs = 175;
    }
    expect(comparePerformanceReports(runs, provenance).failures).toEqual([
      "bundle.firstPaintMs", `${comparisonPolicy.scenarios[0]}.updateDurationsMs.p95`,
    ]);
  });

  it("does not fail on one outlier, small absolute changes, or a small percentage change", () => {
    const { runs, provenance } = fixture();
    for (const run of runs.filter((candidate) => candidate.side === "head")) {
      for (const start of run.starts) start.firstPaintMs = 140; // below the 50 ms floor
      run.renderer.scenarios[0].updateDurationsMs.p95 = 24; // at the 20% boundary
    }
    runs[1].renderer.scenarios[0].updateDurationsMs.p95 = 200;
    expect(comparePerformanceReports(runs, provenance).failures).toEqual([]);
  });

  it("uses paired changes despite a runner slowing between rounds", () => {
    const { runs, provenance } = fixture();
    for (const run of runs) {
      for (const start of run.starts) start.firstPaintMs = 100 + run.round * 80 + (run.side === "head" ? -10 : 0);
    }
    expect(comparePerformanceReports(runs, provenance).failures).toEqual([]);
  });

  it.each([
    ["missing pair", (runs) => { runs.pop(); }],
    ["duplicate round", (runs) => { runs[2].round = 0; }],
    ["missing startup", (runs) => { runs[0].starts = []; }],
    ["invalid startup", (runs) => { runs[0].starts[0].firstPaintMs = null; }],
    ["missing renderer scenario", (runs) => { runs[0].renderer.scenarios.pop(); }],
    ["invalid renderer timing", (runs) => { runs[1].renderer.scenarios[0].updateDurationsMs.p95 = NaN; }],
    ["missing raw samples", (runs) => { runs[1].renderer.scenarios[0].rawSamples = []; }],
    ["different fixture", (runs) => { runs[1].renderer.scenarios[0].fixture.bytes++; }],
    ["different harness", (runs) => { runs[1].renderer.harnessSourceSha256 = "0".repeat(64); }],
    ["different Electron", (runs) => { runs[1].renderer.execution.electronVersion = "45.0.0"; }],
    ["different Electron executable", (runs) => { runs[1].renderer.execution.electronExecutable += "-other"; }],
    ["different startup executable", (runs) => { runs[1].starts[0].execution.electronExecutable += "-other"; }],
    ["different GPU backend", (runs) => { runs[1].renderer.execution.gpu.mode = "other"; }],
    ["different machine", (runs) => { runs[1].renderer.machine.chip = "other"; }],
    ["wrong subject", (runs) => { runs[1].renderer.commitSha = "0".repeat(40); }],
    ["different series", (runs) => { runs[1].seriesId = "stale"; }],
    ["shared renderer profile", (runs) => { runs[1].renderer.execution.profileMode = "default"; }],
    ["shared startup profile", (runs) => { runs[1].starts[0].execution.profileMode = "default"; }],
  ])("rejects %s rather than accepting an incomparable run", (_label, mutate) => {
    const { runs, provenance } = fixture();
    mutate(runs);
    expect(() => comparePerformanceReports(runs, provenance)).toThrow("Invalid performance comparison:");
  });
});
