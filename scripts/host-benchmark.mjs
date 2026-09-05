import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile as writeTextFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { evaluateHostBudgets } from "./host-budget.mjs";

const root = process.cwd();
const mode = process.argv.includes("--full") ? "full" : "safe";
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, "reports", `host-${mode}-report.json`);
const alternate = await mkdtemp(join(tmpdir(), "tau-host-benchmark-"));
const historyPath = join(alternate, "projects.json");

// Linear interpolation (Hyndman-Fan type 7), like the renderer benchmark.
function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile) => {
    if (sorted.length === 0) return 0;
    const position = (sorted.length - 1) * percentile;
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) ?? 0 };
}

/** Cold starts per report; one start is a single sample, not a distribution. */
const HOST_RUNS = Math.max(1, Number(process.env.TAU_HOST_BENCH_RUNS ?? 3));

try {
  execFileSync("git", ["init", "-b", "main", alternate], { stdio: "ignore" });
  await writeTextFile(join(alternate, "README.md"), "# benchmark\n");
  execFileSync("git", ["-C", alternate, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", alternate, "-c", "user.name=Tau Benchmark", "-c", "user.email=tau@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  const [{ PiHost }, { ProjectHistory }, { SessionManager }] = await Promise.all([
    import(pathToFileURL(join(root, "dist-electron", "main", "pi-host.js")).href),
    import(pathToFileURL(join(root, "dist-electron", "main", "project-history.js")).href),
    import("@earendil-works/pi-coding-agent"),
  ]);
  const sessionDir = join(alternate, "sessions");
  const sessionPaths = ["First fixture", "Second fixture"].map((name, index) => {
    const manager = SessionManager.create(alternate, sessionDir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `${name} ${index}` }], timestamp: Date.now() + index });
    return manager.getSessionFile();
  });
  if (sessionPaths.some((path) => !path)) throw new Error("Could not create persisted benchmark sessions");
  const wallClock = [];
  let phases = [];
  let background = [];
  for (let hostRun = 0; hostRun < HOST_RUNS; hostRun += 1) {
    const history = new ProjectHistory(historyPath);
    await history.load();
    const host = new PiHost(root, () => {}, history, mode === "safe", false);
    const started = performance.now();
    await host.start();
    wallClock.push({ scenario: "bootstrap", durationMs: performance.now() - started });
    const firstSwitchStarted = performance.now();
    await host.switchSession(sessionPaths[0]);
    wallClock.push({ scenario: "cold-switch", durationMs: performance.now() - firstSwitchStarted });
    for (let run = 0; run < 4; run += 1) {
      const path = sessionPaths[(run + 1) % sessionPaths.length];
      const prewarmStarted = performance.now();
      await host.prewarmSession(path);
      wallClock.push({ scenario: "prewarm", durationMs: performance.now() - prewarmStarted });
      const switchStarted = performance.now();
      await host.switchSession(path);
      wallClock.push({ scenario: "warm-switch", durationMs: performance.now() - switchStarted });
    }
    await host.dispose();
    await history.flush();
    // Phases describe one host; the last start stands for the report.
    phases = host.getLifecycleMeasurements();
    background = host.getBackgroundLifecycleMeasurements();
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    wallClock,
    summaries: Object.fromEntries([...new Set(wallClock.map((sample) => sample.scenario))].map((scenario) => {
      const samples = wallClock.filter((sample) => sample.scenario === scenario).map((sample) => sample.durationMs);
      // The first start of a process is the only cold one; later hosts reuse the SDK's resource cache.
      return [scenario, scenario === "bootstrap" ? { ...summarize(samples), cold: samples[0] } : summarize(samples)];
    })),
    hostRuns: HOST_RUNS,
    phases,
    background,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (check) {
    const budgets = JSON.parse(await readFile(join(root, "scripts", "performance-budgets.json"), "utf8"));
    const failures = evaluateHostBudgets(report, budgets);
    if (failures.length > 0) {
      console.error(`Host budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Host report: ${output}`);
} finally {
  await rm(alternate, { recursive: true, force: true });
}
