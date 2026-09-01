import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname, platform, release, arch } from "node:os";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { buildRendererComparisonReproduction } from "./renderer-comparison-commands.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const HARNESS_FILES = [
  "benchmarks/renderer-fixtures.json",
  "scripts/renderer-benchmark.mjs",
  "scripts/renderer-benchmark-fixture.cjs",
  "scripts/renderer-budget.mjs",
  "scripts/renderer-comparison-commands.mjs",
  "scripts/performance-budgets.json",
  "src/renderer/RendererBenchmark.tsx",
  "src/renderer/components/TranscriptViewport.tsx",
  "src/renderer/components/transcript-navigation.ts",
  "src/renderer/components/transcript-navigation-dom.ts",
  "src/renderer/components/VirtualTranscript.tsx",
  "src/shared/transcript-index.ts",
  "src/shared/transcript-turn.ts",
];

function flagValues(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[++index]);
  }
  return values;
}

function flagValue(flag, fallback) {
  return flagValues(flag)[0] ?? fallback;
}

const output = flagValue("--output", "reports/renderer-transcript-comparison-aggregate.json");
const baselinePaths = flagValues("--baseline");
const currentPaths = flagValues("--current");
const dryRun = process.argv.includes("--dry-run");
const baselineRoot = flagValue("--baseline-root", ROOT);
const currentRoot = flagValue("--current-root", ROOT);
const subjectRoot = flagValue("--subject-root", ROOT);
const baselineCommit = flagValues("--baseline-commit")[0] ?? gitCommit(baselineRoot);
const currentCommit = flagValues("--current-commit")[0] ?? gitCommit(currentRoot);
const baselinePatch = flagValue("--baseline-patch", "reports/renderer-transcript-legacy-baseline.patch");

const baselinePatchPath = isAbsolute(baselinePatch) ? baselinePatch : join(subjectRoot, baselinePatch);
const outputPath = isAbsolute(output) ? output : join(subjectRoot, output);
const reproduction = buildRendererComparisonReproduction({
  currentRoot,
  subjectRoot,
  baselineCommit,
  currentCommit,
  baselinePatch: baselinePatchPath,
  output: outputPath,
});

if (dryRun) {
  console.log(JSON.stringify(reproduction, null, 2));
  process.exit(0);
}

if (baselinePaths.length < 2 || currentPaths.length < 2) {
  throw new Error("Pass at least two complete --baseline and --current renderer reports.");
}

assertDetachedCommit(baselineRoot, baselineCommit, "baseline");
assertDetachedCommit(currentRoot, currentCommit, "current");

function gitCommit(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitBranch(root) {
  try {
    return execFileSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

function assertDetachedCommit(root, expectedCommit, label) {
  const actualCommit = gitCommit(root);
  if (actualCommit === "unknown") throw new Error(`${label} renderer root is not a Git checkout: ${root}`);
  if (actualCommit !== expectedCommit) {
    throw new Error(`${label} renderer root is at ${actualCommit}, expected ${expectedCommit}`);
  }
  const branch = gitBranch(root);
  if (branch !== null) throw new Error(`${label} renderer root must be detached at ${expectedCommit}, found branch ${branch}`);
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceHash(root) {
  const hash = createHash("sha256");
  for (const file of HARNESS_FILES) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(await readFile(join(root, file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // The design baseline intentionally predates TranscriptViewport and its
      // incremental index. Hash the absence explicitly so baseline/current
      // source hashes remain reproducible and explain the seam.
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function buildHash(root) {
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if ((await stat(path)).isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(join(root, "dist"));
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function scenarioById(report, id) {
  const scenario = report.scenarios?.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`${id} is missing from ${report.generatedAt ?? "the report"}`);
  return scenario;
}

async function rawRuns(paths, id) {
  return Promise.all(paths.map(async (inputPath) => {
    const path = isAbsolute(inputPath) ? inputPath : join(ROOT, inputPath);
    const report = JSON.parse(await readFile(path, "utf8"));
    const scenario = scenarioById(report, id);
    return {
      path: relative(ROOT, path) || inputPath,
      sha256: await sha256File(path),
      generatedAt: report.generatedAt,
      sampleRuns: scenario.sampleRuns,
      metrics: {
        frameIntervalsMs: scenario.frameIntervalsMs,
        longTasksMs: scenario.longTasksMs,
        commitDurationsMs: scenario.commitDurationsMs,
        domNodes: scenario.domNodes,
        heapBytes: scenario.heapBytes,
      },
    };
  }));
}

function summarize(runs) {
  const metrics = (name) => {
    const values = runs.map((run) => run.metrics[name]);
    return {
      median: percentile(values.map((value) => value.median), 0.5),
      p95: percentile(values.map((value) => value.p95), 0.95),
      maximum: Math.max(0, ...values.map((value) => value.maximum)),
    };
  };
  const maximum = (name) => Math.max(0, ...runs.map((run) => run.metrics[name].maximum));
  return {
    runCount: runs.length,
    sampleRunsPerCompleteRun: runs.map((run) => run.sampleRuns),
    frameIntervalsMs: metrics("frameIntervalsMs"),
    longTasksMs: metrics("longTasksMs"),
    commitDurationsMs: metrics("commitDurationsMs"),
    domNodes: Math.max(0, ...runs.map((run) => run.metrics.domNodes)),
    heapBytes: metrics("heapBytes"),
    variability: {
      frameP95Ms: { minimum: Math.min(...runs.map((run) => run.metrics.frameIntervalsMs.p95)), maximum: maximum("frameIntervalsMs") },
      commitP95Ms: { minimum: Math.min(...runs.map((run) => run.metrics.commitDurationsMs.p95)), maximum: maximum("commitDurationsMs") },
      longTaskMaximumMs: { minimum: Math.min(...runs.map((run) => run.metrics.longTasksMs.maximum)), maximum: maximum("longTasksMs") },
      heapMedianBytes: { minimum: Math.min(...runs.map((run) => run.metrics.heapBytes.median)), maximum: maximum("heapBytes") },
    },
  };
}

const baselineId = "transcript-legacy-comparison-1000-turns";
const currentId = baselineId;
const currentAnchoredId = "transcript-viewport-anchored-1000-turns";
const currentStreamingId = "transcript-viewport-streaming-1000-turns";
const baselineRuns = await rawRuns(baselinePaths, baselineId);
const currentRuns = await rawRuns(currentPaths, currentId);

const firstCurrent = JSON.parse(await readFile(isAbsolute(currentPaths[0]) ? currentPaths[0] : join(ROOT, currentPaths[0]), "utf8"));
const workloadFixture = scenarioById(firstCurrent, currentAnchoredId).fixture;
const workloadHash = createHash("sha256").update(JSON.stringify({
  turns: workloadFixture.turns,
  anchorTurn: workloadFixture.anchorTurn,
  activities: workloadFixture.activities,
  streamingDeltas: scenarioById(firstCurrent, currentStreamingId).fixture.streamingDeltas,
})).digest("hex");
const currentAnchoredRuns = await Promise.all(currentPaths.map(async (inputPath) => {
  const path = isAbsolute(inputPath) ? inputPath : join(ROOT, inputPath);
  const report = JSON.parse(await readFile(path, "utf8"));
  const scenario = scenarioById(report, currentAnchoredId);
  return {
    path: relative(ROOT, path) || inputPath,
    sha256: await sha256File(path),
    generatedAt: report.generatedAt,
    sampleRuns: scenario.sampleRuns,
    metrics: {
      frameIntervalsMs: scenario.frameIntervalsMs,
      longTasksMs: scenario.longTasksMs,
      commitDurationsMs: scenario.commitDurationsMs,
      domNodes: scenario.domNodes,
      heapBytes: scenario.heapBytes,
    },
  };
}));
const currentStreamingRuns = await Promise.all(currentPaths.map(async (inputPath) => {
  const path = isAbsolute(inputPath) ? inputPath : join(ROOT, inputPath);
  const report = JSON.parse(await readFile(path, "utf8"));
  const scenario = scenarioById(report, currentStreamingId);
  return {
    path: relative(ROOT, path) || inputPath,
    sha256: await sha256File(path),
    generatedAt: report.generatedAt,
    sampleRuns: scenario.sampleRuns,
    metrics: {
      frameIntervalsMs: scenario.frameIntervalsMs,
      longTasksMs: scenario.longTasksMs,
      commitDurationsMs: scenario.commitDurationsMs,
      domNodes: scenario.domNodes,
      heapBytes: scenario.heapBytes,
    },
  };
}));

const baselineSourceHash = await sourceHash(baselineRoot);
const currentSourceHash = await sourceHash(currentRoot);
const baselineBuildHash = await buildHash(baselineRoot);
const currentBuildHash = await buildHash(currentRoot);
const patchPath = baselinePatchPath;
const startConditions = firstCurrent.startConditions;
const result = {
  schemaVersion: 2,
  comparison: "same deterministic transcript workload; legacy VirtualTranscript versus anchored TranscriptViewport",
  generatedAt: new Date().toISOString(),
  workload: {
    turns: workloadFixture.turns,
    anchorTurn: workloadFixture.anchorTurn,
    activities: workloadFixture.activities,
    streamingDeltas: scenarioById(firstCurrent, currentStreamingId).fixture.streamingDeltas,
    fixtureIds: { baseline: baselineId, anchored: currentAnchoredId, streaming: currentStreamingId },
    dataSha256: workloadHash,
  },
  environment: {
    machine: hostname(),
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    viewport: startConditions.viewport,
    throttle: startConditions.throttle,
    warmupRuns: startConditions.warmupRuns,
    sampleRuns: startConditions.sampleRuns,
    parallelRuns: 1,
  },
  baseline: {
    commit: baselineCommit,
    component: "VirtualTranscript",
    sourceSha256: baselineSourceHash,
    buildArtifactSha256: baselineBuildHash,
    harnessPatch: baselinePatch,
    harnessPatchSha256: await sha256File(patchPath),
    runs: baselineRuns,
    aggregate: summarize(baselineRuns),
  },
  current: {
    commit: currentCommit,
    component: "TranscriptViewport",
    sourceSha256: currentSourceHash,
    buildArtifactSha256: currentBuildHash,
    runs: currentRuns,
    aggregate: summarize(currentRuns),
  },
  anchored: {
    requiredScenario: true,
    runs: currentAnchoredRuns,
    aggregate: summarize(currentAnchoredRuns),
  },
  streaming: {
    scenario: currentStreamingId,
    runs: currentStreamingRuns,
    aggregate: summarize(currentStreamingRuns),
    measuredPath: "TranscriptMessageIndex.update + TranscriptViewport revision + VirtualTranscript window",
  },
  reproduction: {
    ...reproduction,
    caveat: "Each raw report contains five measured samples after two warm-ups; aggregate p95/max values are aggregated from all complete-run summaries. Electron scheduling, GPU state, and other desktop load remain uncontrolled.",
  },
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Renderer comparison aggregate: ${outputPath}`);
