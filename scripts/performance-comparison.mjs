import { isDeepStrictEqual } from "node:util";

// Copy these measurement sources from the gate checkout into BOTH subjects.
// Product components imported by RendererBenchmark remain each subject's own.
export const rendererHarnessFiles = [
  "benchmarks/renderer-fixtures.json",
  "scripts/renderer-benchmark.mjs",
  "scripts/renderer-benchmark-fixture.cjs",
  "scripts/machine-class.mjs",
  "scripts/renderer-budget.mjs",
  "scripts/performance-budgets.json",
  "scripts/performance-comparison.mjs",
  "src/renderer/RendererBenchmark.tsx",
  "src/renderer/RendererBenchmarkApp.tsx",
  "src/renderer/RendererBenchmarkActivityStream.tsx",
  "src/renderer/RendererBenchmarkDiffStack.tsx",
];

export const comparisonHarnessFiles = [...rendererHarnessFiles, "scripts/start-report.mjs", "scripts/start-fixture.cjs"];
export const comparisonPolicy = {
  pairs: 5,
  warmupRuns: 1,
  sampleRuns: 3,
  scenarios: ["markdown-code-stream-150kb", "transcript-viewport-streaming-1000-turns", "composer-typing-long"],
  relativeIncrease: 0.2,
  // Floor small absolute changes, especially the frame interval's vsync steps.
  rendererMetrics: { mountDurationsMs: 5, updateDurationsMs: 5, frameIntervalsMs: 8 },
  firstPaintIncreaseMs: 50,
};

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid performance comparison: ${message}`);
}

function positive(value, label) {
  requireValue(Number.isFinite(value) && value > 0, `${label} must be a positive finite measurement`);
  return value;
}

function same(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `${label} differs between reports`);
}

function gpuIdentity(gpu) {
  // getGPUInfo includes per-launch timings such as initializationTime. Keep
  // adapter/backend identity without treating those measurements as settings.
  return {
    mode: gpu?.mode,
    featureStatus: gpu?.featureStatus,
    devices: gpu?.info?.gpuDevice,
    renderer: gpu?.info?.auxAttributes?.glRenderer,
    implementation: gpu?.info?.auxAttributes?.glImplementationParts,
  };
}

/** Fail closed before making any timing decision. Inputs are fresh paired runs,
 * never cached reports from a different runner, harness, or set of fixtures. */
export function comparePerformanceReports(runs, provenance) {
  requireValue(Array.isArray(runs) && runs.length === comparisonPolicy.pairs * 2, "five complete base/head pairs are required");
  for (const field of ["baseCommit", "headCommit"]) {
    requireValue(/^[a-f0-9]{40}$/u.test(provenance?.[field] ?? ""), `${field} is missing`);
  }
  requireValue(/^[a-f0-9]{64}$/u.test(provenance?.harnessSha256 ?? ""), "harness hash is missing");
  requireValue(typeof provenance?.seriesId === "string" && provenance.seriesId.length > 0, "series ID is missing");
  const first = runs[0];
  requireValue(first.renderer?.machine?.chip && first.renderer?.execution?.electronVersion, "machine/Electron metadata is missing");
  requireValue(first.renderer?.execution?.gpu?.featureStatus && Object.keys(first.renderer.execution.gpu.featureStatus).length > 0, "GPU metadata is missing");
  requireValue(first.renderer.startConditions?.warmupRuns === comparisonPolicy.warmupRuns && first.renderer.startConditions?.sampleRuns === comparisonPolicy.sampleRuns, "unexpected warmup/sample count");
  requireValue(Array.isArray(first.renderer.scenarios) && first.renderer.scenarios.length === comparisonPolicy.scenarios.length, "scenario coverage is incomplete");
  const pairs = [];
  for (let round = 0; round < comparisonPolicy.pairs; round += 1) {
    const pair = {};
    for (const side of ["base", "head"]) {
      const matches = runs.filter((run) => run.round === round && run.side === side);
      requireValue(matches.length === 1, `pair ${round} ${side} is missing or duplicated`);
      const run = matches[0];
      const report = run.renderer;
      requireValue(run.seriesId === provenance.seriesId, "run belongs to another series");
      same(run.harnessSha256, provenance.harnessSha256, "copied harness hash");
      same(report?.commitSha, provenance[`${side}Commit`], `${side} source commit`);
      requireValue(report.schemaVersion === 2, "unknown renderer report schema");
      for (const key of ["machine", "startConditions", "harnessSourceSha256", "harnessFileSha256"]) same(report[key], first.renderer[key], key);
      requireValue(/^[a-f0-9]{64}$/u.test(report.harnessSourceSha256 ?? "") && Object.keys(report.harnessFileSha256 ?? {}).length === rendererHarnessFiles.length, "renderer harness provenance is missing");
      requireValue(/^[a-f0-9]{64}$/u.test(report.buildArtifactSha256 ?? ""), "renderer build hash is missing");
      for (const key of ["electronVersion", "parallelRuns"]) same(report.execution?.[key], first.renderer.execution[key], `execution.${key}`);
      same(gpuIdentity(report.execution?.gpu), gpuIdentity(first.renderer.execution.gpu), "GPU adapter/backend");
      requireValue(report.execution.parallelRuns === 1, "measurements must run sequentially");
      requireValue(report.execution.profileMode === "fresh-per-process", "renderer profile must be fresh for each process");
      requireValue(report.scenarios?.length === comparisonPolicy.scenarios.length, "scenario coverage is incomplete");
      for (const id of comparisonPolicy.scenarios) {
        const scenarios = report.scenarios.filter((scenario) => scenario.id === id);
        requireValue(scenarios.length === 1, `${id} is missing or duplicated`);
        const scenario = scenarios[0];
        same(scenario.fixture, first.renderer.scenarios.find((candidate) => candidate.id === id)?.fixture, `${id} workload`);
        requireValue(scenario.fixture?.id === id, `${id} fixture is missing`);
        requireValue(scenario.sampleRuns === comparisonPolicy.sampleRuns && scenario.rawSamples?.length === comparisonPolicy.sampleRuns, `${id} samples are incomplete`);
        for (const metric of Object.keys(comparisonPolicy.rendererMetrics)) {
          positive(scenario[metric]?.median, `${id} ${metric} median`);
          positive(scenario[metric]?.p95, `${id} ${metric} p95`);
          for (const sample of scenario.rawSamples) {
            requireValue(Array.isArray(sample[metric]) && sample[metric].length > 0, `${id} raw ${metric} missing`);
            for (const value of sample[metric]) positive(value, `${id} raw ${metric}`);
          }
        }
      }
      requireValue(Array.isArray(run.starts) && run.starts.length === comparisonPolicy.sampleRuns, "startup samples are incomplete");
      for (const start of run.starts) {
        requireValue(start.schemaVersion === 1 && start.measurement === "renderer-bundle-fixture", "unknown startup report");
        requireValue(start.execution?.profileMode === "fresh-per-process", "startup profile must be fresh for each process");
        same(start.execution?.electronVersion, report.execution.electronVersion, "startup Electron version");
        positive(start.firstPaintMs, "first paint");
        requireValue(Array.isArray(start.externalRequests) && start.externalRequests.length === 0, "startup external requests were not measured or were nonzero");
      }
      pair[side] = run;
    }
    pairs.push(pair);
  }
  const metrics = [];
  function compare(name, read, absoluteFloorMs) {
    const base = pairs.map((pair) => read(pair.base));
    const head = pairs.map((pair) => read(pair.head));
    const differences = base.map((value, index) => head[index] - value);
    const relativeChanges = base.map((value, index) => differences[index] / value);
    const increaseMs = median(differences);
    const relativeIncrease = median(relativeChanges);
    // One noisy pair cannot fail the gate. Require all five head measurements
    // to be slower, plus material median absolute AND proportional increases.
    const failed = differences.every((value) => value > 0)
      && increaseMs > absoluteFloorMs && relativeIncrease > comparisonPolicy.relativeIncrease;
    metrics.push({ name, base, head, baseMedianMs: median(base), headMedianMs: median(head), increaseMs, relativeIncrease, absoluteFloorMs, failed });
  }
  compare("bundle.firstPaintMs", (run) => median(run.starts.map((start) => start.firstPaintMs)), comparisonPolicy.firstPaintIncreaseMs);
  for (const id of comparisonPolicy.scenarios) {
    for (const [metric, floor] of Object.entries(comparisonPolicy.rendererMetrics)) {
      const statistic = metric === "mountDurationsMs" ? "median" : "p95";
      compare(`${id}.${metric}.${statistic}`, (run) => run.renderer.scenarios.find((scenario) => scenario.id === id)[metric][statistic], floor);
    }
  }
  return { schemaVersion: 1, provenance, policy: comparisonPolicy, metrics, failures: metrics.filter((metric) => metric.failed).map((metric) => metric.name) };
}
