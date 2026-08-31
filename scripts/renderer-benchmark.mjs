import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRendererBudgets } from "./renderer-budget.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = join(ROOT, "node_modules", ".bin", "electron");
const fixture = JSON.parse(await readFile(join(ROOT, "benchmarks", "renderer-fixtures.json"), "utf8"));
const budgets = JSON.parse(await readFile(join(ROOT, "scripts", "performance-budgets.json"), "utf8"));
const args = process.argv.slice(2);
const check = args.includes("--check");
const skipBuild = args.includes("--no-build");
const outputArg = args.find((arg) => !arg.startsWith("--"));
const outputPath = join(ROOT, outputArg ?? "reports/renderer-report.json");

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

function machineClass() {
  if (process.platform !== "darwin") return { platform: process.platform, architecture: process.arch };
  const sysctl = (name) => execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
  return {
    platform: "darwin",
    architecture: process.arch,
    modelIdentifier: sysctl("hw.model"),
    chip: sysctl("machdep.cpu.brand_string"),
    memoryGiB: Math.round(Number(sysctl("hw.memsize")) / 1024 ** 3),
    logicalCores: Number(sysctl("hw.ncpu")),
  };
}

if (!skipBuild) run("npm", ["run", "build"]);

function sampleScenario(scenario) {
  const samples = [];
  for (let runIndex = 0; runIndex < fixture.startConditions.warmupRuns + fixture.startConditions.sampleRuns; runIndex += 1) {
    const stdout = run(ELECTRON, [join(ROOT, "scripts", "renderer-benchmark-fixture.cjs"), scenario.id]);
    const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.startsWith("{"));
    if (!line) throw new Error(`renderer fixture returned no JSON for ${scenario.id}`);
    if (runIndex >= fixture.startConditions.warmupRuns) samples.push(JSON.parse(line));
  }
  const frames = samples.flatMap((sample) => sample.frameIntervalsMs);
  const longTasks = samples.flatMap((sample) => sample.longTasksMs);
  const commitDurations = samples.flatMap((sample) => sample.commitDurationsMs);
  const heaps = samples.map((sample) => sample.heapBytes ?? 0);
  return {
    id: scenario.id,
    fixture: scenario,
    sampleRuns: samples.length,
    longTaskObserverSupported: samples.every((sample) => sample.longTaskObserverSupported === true),
    frameIntervalsMs: { median: percentile(frames, 0.5), p95: percentile(frames, 0.95), maximum: Math.max(0, ...frames) },
    longTasksMs: { count: longTasks.length, median: percentile(longTasks, 0.5), p95: percentile(longTasks, 0.95), maximum: Math.max(0, ...longTasks) },
    commitDurationsMs: { median: percentile(commitDurations, 0.5), p95: percentile(commitDurations, 0.95), maximum: Math.max(0, ...commitDurations) },
    commits: Math.max(...samples.map((sample) => sample.commits)),
    domNodes: Math.max(...samples.map((sample) => sample.domNodes)),
    heapBytes: { median: percentile(heaps, 0.5), p95: percentile(heaps, 0.95), maximum: Math.max(0, ...heaps) },
  };
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  machine: machineClass(),
  startConditions: fixture.startConditions,
  scenarios: fixture.scenarios.map(sampleScenario),
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

const failures = check ? evaluateRendererBudgets(report, budgets) : [];
console.log(`Renderer report: ${outputPath}`);
if (failures.length > 0) {
  console.error(`Renderer budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
}
