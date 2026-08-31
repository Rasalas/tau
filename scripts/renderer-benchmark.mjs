import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

function buildArtifactSha256() {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      if (statSync(file).isDirectory()) visit(file);
      else files.push(file);
    }
  };
  visit(join(ROOT, "dist"));
  return createHash("sha256")
    .update(files.map((file) => `${file.slice(ROOT.length)}\0${readFileSync(file)}`).join("\0"))
    .digest("hex");
}

const harnessFiles = [
  "benchmarks/renderer-fixtures.json",
  "scripts/renderer-benchmark.mjs",
  "scripts/renderer-benchmark-fixture.cjs",
  "scripts/machine-class.mjs",
  "scripts/renderer-budget.mjs",
  "scripts/performance-budgets.json",
  "src/renderer/RendererBenchmark.tsx",
];
const harnessSourceSha256 = createHash("sha256")
  .update(harnessFiles.map((file) => `${file}\0${readFileSync(join(ROOT, file))}`).join("\0"))
  .digest("hex");
const harnessPatchFile = process.env.TAU_BENCHMARK_HARNESS_PATCH_FILE ?? "reports/renderer-baseline-6ddb454-harness.patch";
const harnessPatchPath = join(ROOT, harnessPatchFile);
const harnessPatchSha256 = process.env.TAU_BENCHMARK_HARNESS_PATCH_SHA256
  ?? (existsSync(harnessPatchPath)
    ? createHash("sha256").update(readFileSync(harnessPatchPath)).digest("hex")
    : harnessSourceSha256);
const subjectCommit = process.env.TAU_BENCHMARK_SUBJECT_COMMIT ?? commitSha();
const harnessCommit = process.env.TAU_BENCHMARK_HARNESS_COMMIT ?? commitSha();

if (!skipBuild) run("npm", ["run", "build"]);

function sampleScenario(scenario) {
  const samples = [];
  for (let runIndex = 0; runIndex < fixture.startConditions.warmupRuns + fixture.startConditions.sampleRuns; runIndex += 1) {
    const stdout = run(ELECTRON, [join(ROOT, "scripts", "renderer-benchmark-fixture.cjs"), scenario.id, JSON.stringify(scenario)]);
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
    if (!Array.isArray(result.frameIntervalsMs) || result.frameIntervalsMs.length < (sanity.minFrames ?? 1) || result.frameIntervalsMs.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`renderer fixture returned invalid frame measurements for ${scenario.id}`);
    }
    if (!Array.isArray(result.longTasksMs) || result.longTasksMs.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`renderer fixture returned invalid Long Task measurements for ${scenario.id}`);
    }
    if (!Array.isArray(result.startupLongTasksMs) || result.startupLongTasksMs.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`renderer fixture returned invalid startup Long Task measurements for ${scenario.id}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(result.electronVersion ?? "") || result.gpuFeatureStatus === null || typeof result.gpuFeatureStatus !== "object" || Object.keys(result.gpuFeatureStatus).length === 0) {
      throw new Error(`renderer fixture returned incomplete Electron/GPU metadata for ${scenario.id}`);
    }
    const activeGpu = result.gpuInfo?.gpuDevice?.find((device) => device.active && typeof device.deviceString === "string" && device.deviceString.length > 0);
    const softwareGpu = result.gpuFeatureStatus.gpu_compositing === "disabled_software";
    if (!activeGpu && !softwareGpu) throw new Error(`renderer fixture returned no verified GPU adapter/backend for ${scenario.id}`);
    if (!Number.isFinite(result.heapBytes) || result.heapBytes <= 0) {
      throw new Error(`renderer fixture returned invalid heap measurement for ${scenario.id}`);
    }
    if (!Number.isFinite(result.domNodes) || result.domNodes < (sanity.minDomNodes ?? 1) || result.domNodes > (sanity.maxDomNodes ?? Number.POSITIVE_INFINITY)) {
      throw new Error(`renderer fixture returned implausible DOM node count for ${scenario.id}: ${result.domNodes}`);
    }
    if (!Number.isInteger(result.commits) || result.commits < (sanity.minCommits ?? 1)) {
      throw new Error(`renderer fixture returned too few commits for ${scenario.id}: ${result.commits}`);
    }
    if (scenario.id === "diff-2mb" && (!Number.isFinite(result.payloadBytes) || result.payloadBytes < scenario.bytes)) {
      throw new Error(`renderer fixture did not render the configured diff payload for ${scenario.id}: ${result.payloadBytes}`);
    }
    if (scenario.id === "long-user-message" && (!result.longMessageInteraction?.toggleFound || !result.longMessageInteraction.expanded || !Number.isFinite(result.longMessageInteraction.contentBytes) || result.longMessageInteraction.contentBytes < scenario.bytes)) {
      throw new Error(`renderer fixture did not complete the real long-message interaction for ${scenario.id}`);
    }
    if (runIndex >= fixture.startConditions.warmupRuns) samples.push(result);
  }
  const frames = samples.flatMap((sample) => sample.frameIntervalsMs);
  const longTasks = samples.flatMap((sample) => sample.longTasksMs);
  const startupLongTasks = samples.flatMap((sample) => sample.startupLongTasksMs);
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
    environment: {
      electronVersion: samples[0].electronVersion,
      gpuFeatureStatus: samples[0].gpuFeatureStatus,
      gpuInfo: samples[0].gpuInfo ?? null,
    },
    longTaskObserverSupported: samples.every((sample) => sample.longTaskObserverSupported === true),
    frameIntervalsMs: { median: percentile(frames, 0.5), p95: percentile(frames, 0.95), maximum: Math.max(0, ...frames) },
    longTasksMs: { count: longTasks.length, median: percentile(longTasks, 0.5), p95: percentile(longTasks, 0.95), maximum: Math.max(0, ...longTasks) },
    startupLongTasksMs: { count: startupLongTasks.length, median: percentile(startupLongTasks, 0.5), p95: percentile(startupLongTasks, 0.95), maximum: Math.max(0, ...startupLongTasks) },
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
  harnessSourceSha256,
  harnessPatchSha256,
  reproducibilityScript: "scripts/reproduce-renderer-baseline.mjs",
  buildArtifactSha256: buildArtifactSha256(),
  execution: {
    electronExecutable: "node_modules/.bin/electron",
    gpu: { mode: "default" },
    parallelRuns: 1,
    harnessFiles,
    harnessPatchFile,
    caveats: "Scenarios run sequentially in hidden production Electron windows; reports are invalidated before write when fixture sanity checks fail.",
  },
  machine: machineClass(),
  startConditions: fixture.startConditions,
  scenarios: fixture.scenarios.map(sampleScenario),
};
report.execution.gpu = {
  mode: "default",
  featureStatus: report.scenarios[0]?.environment.gpuFeatureStatus ?? {},
  info: report.scenarios[0]?.environment.gpuInfo ?? null,
};
report.execution.electronVersion = report.scenarios[0]?.environment.electronVersion ?? "unknown";
for (const scenario of report.scenarios) delete scenario.environment;
for (const scenario of report.scenarios) {
  for (const metric of ["frameIntervalsMs", "longTasksMs", "startupLongTasksMs", "mountDurationsMs", "updateDurationsMs", "heapBytes"]) {
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
