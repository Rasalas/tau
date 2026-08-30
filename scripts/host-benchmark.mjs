import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile as writeTextFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { evaluateHostBudgets } from "./host-budget.mjs";

const root = process.cwd();
const mode = process.argv.includes("--full") ? "full" : "safe";
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, "reports", `host-${mode}-report.json`);
const alternate = await mkdtemp(join(tmpdir(), "tau-host-benchmark-"));
const historyPath = join(alternate, "projects.json");

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile) => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
  return { median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) ?? 0 };
}

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
  const history = new ProjectHistory(historyPath);
  await history.load();
  const host = new PiHost(root, () => {}, history, mode === "safe", false);
  const wallClock = [];
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
  const phases = host.getLifecycleMeasurements();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    wallClock,
    summaries: Object.fromEntries([...new Set(wallClock.map((sample) => sample.scenario))].map((scenario) => [
      scenario,
      summarize(wallClock.filter((sample) => sample.scenario === scenario).map((sample) => sample.durationMs)),
    ])),
    phases,
    background: host.getBackgroundLifecycleMeasurements(),
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (check) {
    const failures = evaluateHostBudgets(report);
    if (failures.length > 0) {
      console.error(`Host budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Host report: ${output}`);
} finally {
  await rm(alternate, { recursive: true, force: true });
}
