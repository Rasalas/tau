import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRendererBudgets } from "./renderer-budget.mjs";
import { machineClass } from "./machine-class.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = join(ROOT, "node_modules", ".bin", "electron");
const fixture = JSON.parse(await readFile(join(ROOT, "benchmarks", "renderer-fixtures.json"), "utf8"));
const budgets = JSON.parse(await readFile(join(ROOT, "scripts", "performance-budgets.json"), "utf8"));
const args = process.argv.slice(2);
const check = args.includes("--check");
const skipBuild = args.includes("--no-build");
const outputArg = args.find((arg) => !arg.startsWith("--"));
const outputPath = outputArg ? (isAbsolute(outputArg) ? outputArg : join(ROOT, outputArg)) : join(ROOT, "reports/renderer-report.json");

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function run(command, commandArgs) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(command, commandArgs, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}

function commitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const harnessFiles = [
  "benchmarks/renderer-fixtures.json",
  "scripts/renderer-benchmark.mjs",
  "scripts/renderer-benchmark-fixture.cjs",
  "src/renderer/RendererBenchmark.tsx",
];
const harnessPatchSha256 = createHash("sha256")
  .update(harnessFiles.map((file) => `${file}\0${readFileSync(join(ROOT, file))}`).join("\0"))
  .digest("hex");
const subjectCommit = process.env.TAU_BENCHMARK_SUBJECT_COMMIT ?? commitSha();
const harnessCommit = process.env.TAU_BENCHMARK_HARNESS_COMMIT ?? commitSha();

if (!skipBuild) run("npm", ["run", "build"]);

function sampleScenario(scenario) {
  const samples = [];
  for (let runIndex = 0; runIndex < fixture.startConditions.warmupRuns + fixture.startConditions.sampleRuns; runIndex += 1) {
    const stdout = run(ELECTRON, [join(ROOT, "scripts", "renderer-benchmark-fixture.cjs"), scenario.id]);
    const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.startsWith("{"));
    if (!line) throw new Error(`renderer fixture returned no JSON for ${scenario.id}`);
    const result = JSON.parse(line);
    const sanity = scenario.sanity ?? {};
    if (result.ready !== true || result.scenario !== scenario.id) {
      throw new Error(`renderer fixture returned an invalid readiness marker for ${scenario.id}`);
    }
    if (result.profilerMountCaptured !== true || !Array.isArray(result.mountDurationsMs) || result.mountDurationsMs.length === 0 || result.mountDurationsMs.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`renderer fixture did not capture a valid Profiler mount for ${scenario.id}`);
    }
    if (!Array.isArray(result.updateDurationsMs) || result.updateDurationsMs.length === 0 || result.updateDurationsMs.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`renderer fixture did not capture a valid Profiler update for ${scenario.id}`);
    }
    if (!Number.isFinite(result.domNodes) || result.domNodes < (sanity.minDomNodes ?? 1) || result.domNodes > (sanity.maxDomNodes ?? Number.POSITIVE_INFINITY)) {
      throw new Error(`renderer fixture returned implausible DOM node count for ${scenario.id}: ${result.domNodes}`);
    }
    if (!Number.isFinite(result.commits) || result.commits < (sanity.minCommits ?? 1)) {
      throw new Error(`renderer fixture returned too few commits for ${scenario.id}: ${result.commits}`);
    }
    if (!Array.isArray(result.frameIntervalsMs) || result.frameIntervalsMs.length < (sanity.minFrames ?? 1)) {
      throw new Error(`renderer fixture returned too few frame samples for ${scenario.id}`);
    }
    if (runIndex >= fixture.startConditions.warmupRuns) samples.push(result);
  }
  const frames = samples.flatMap((sample) => sample.frameIntervalsMs);
  const longTasks = samples.flatMap((sample) => sample.longTasksMs);
  const mountDurations = samples.flatMap((sample) => sample.mountDurationsMs);
  const updateDurations = samples.flatMap((sample) => sample.updateDurationsMs);
  const heaps = samples.map((sample) => sample.heapBytes ?? 0);
  if (samples.length === 0 || frames.length === 0 || mountDurations.length === 0 || updateDurations.length === 0) {
    throw new Error(`renderer fixture produced no accepted measurements for ${scenario.id}`);
  }
  return {
    id: scenario.id,
    fixture: scenario,
    sampleRuns: samples.length,
    longTaskObserverSupported: samples.every((sample) => sample.longTaskObserverSupported === true),
    frameIntervalsMs: { median: percentile(frames, 0.5), p95: percentile(frames, 0.95), maximum: Math.max(0, ...frames) },
    longTasksMs: { count: longTasks.length, median: percentile(longTasks, 0.5), p95: percentile(longTasks, 0.95), maximum: Math.max(0, ...longTasks) },
    mountDurationsMs: { median: percentile(mountDurations, 0.5), p95: percentile(mountDurations, 0.95), maximum: Math.max(0, ...mountDurations) },
    updateDurationsMs: { median: percentile(updateDurations, 0.5), p95: percentile(updateDurations, 0.95), maximum: Math.max(0, ...updateDurations) },
    commits: Math.max(...samples.map((sample) => sample.commits)),
    domNodes: Math.max(...samples.map((sample) => sample.domNodes)),
    heapBytes: { median: percentile(heaps, 0.5), p95: percentile(heaps, 0.95), maximum: Math.max(0, ...heaps) },
  };
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  commitSha: commitSha(),
  subjectCommit,
  harnessCommit,
  harnessPatchSha256,
  execution: {
    electronExecutable: "node_modules/.bin/electron",
    gpu: "default",
    parallelRuns: 1,
    harnessFiles,
    caveats: "Scenarios run sequentially in hidden production Electron windows; reports are invalidated before write when fixture sanity checks fail.",
  },
  machine: machineClass(),
  startConditions: fixture.startConditions,
  scenarios: fixture.scenarios.map(sampleScenario),
};
for (const scenario of report.scenarios) {
  for (const metric of ["frameIntervalsMs", "longTasksMs", "mountDurationsMs", "updateDurationsMs", "heapBytes"]) {
    const distribution = scenario[metric];
    if (distribution && distribution.p95 > distribution.maximum) throw new Error(`${scenario.id} ${metric} p95 exceeds maximum`);
  }
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

const failures = check ? evaluateRendererBudgets(report, budgets) : [];
console.log(`Renderer report: ${outputPath}`);
if (failures.length > 0) {
  console.error(`Renderer budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
}
