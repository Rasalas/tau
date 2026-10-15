import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle-only renderer fixture. Real app startup is measured by compare/run.mjs.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = join(ROOT, "node_modules", ".bin", "electron");
const REPORT_PATH = join(ROOT, "reports", "start-report.json");
const BUDGET_PATH = join(ROOT, "scripts", "performance-budgets.json");

export function evaluateStartBudgets(report, budgets, { timings = true } = {}) {
  const failures = [];
  if (!Number.isFinite(report.firstPaintMs)) failures.push("firstPaintMs was not reported by the browser fixture");
  else if (timings && report.firstPaintMs > budgets.firstPaintMs) failures.push(`firstPaintMs ${report.firstPaintMs} > budget ${budgets.firstPaintMs}`);
  if (!Array.isArray(report.externalRequests)) failures.push("externalRequests was not reported by the browser fixture");
  else if (report.externalRequests.length > budgets.externalNetworkRequests) {
    failures.push(`externalNetworkRequests ${report.externalRequests.length} > budget ${budgets.externalNetworkRequests}`);
  }
  for (const [component, measurement] of Object.entries(report.overlayComposition?.components ?? {})) {
    if (measurement.backdropBlur) failures.push(`${component} uses backdrop blur above the tested fallback`);
    if (timings && measurement.measuredMs > budgets.overlayCompositionMs) {
      failures.push(`${component} overlay composition ${measurement.measuredMs}ms > budget ${budgets.overlayCompositionMs}`);
    }
  }
  return failures;
}

/**
 * The env for the Electron fixture child. `ELECTRON_RUN_AS_NODE` in the
 * caller's own shell (common in an agent's environment) would run this
 * binary as plain Node instead of Electron, so `app.whenReady` never exists.
 */
export function buildFixtureEnv(baseEnv = process.env) {
  const env = { ...baseEnv, ELECTRON_IS_DEV: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runFixture() {
  const result = spawnSync(ELECTRON, [join(ROOT, "scripts", "start-fixture.cjs")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildFixtureEnv(),
  });
  if (result.status !== 0) throw new Error(result.stderr || "start fixture failed");
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("start fixture returned no measurements");
  return JSON.parse(line);
}

async function main() {
  const measurements = runFixture();
  const report = {
    schemaVersion: 1,
    measurement: "renderer-bundle-fixture",
    generatedAt: new Date().toISOString(),
    execution: {
      electronVersion: measurements.electronVersion,
      profileMode: process.env.TAU_BENCHMARK_PROFILE_ROOT ? "fresh-per-process" : "default",
    },
    firstPaintMs: measurements.firstPaintMs,
    firstContentfulPaintMs: measurements.firstContentfulPaintMs,
    loadedResourceCount: measurements.loadedResourceCount,
    resources: measurements.resources,
    externalRequests: measurements.externalRequests,
    paints: measurements.paints,
    overlayComposition: {
      budgetMs: 4,
      components: measurements.overlayStyles,
    },
  };
  await mkdir(join(ROOT, "reports"), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const structuralOnly = process.argv.includes("--check-structural") && !process.argv.includes("--check");
  if (process.argv.includes("--check") || structuralOnly) {
    const budgets = JSON.parse(await readFile(BUDGET_PATH, "utf8"));
    const failures = evaluateStartBudgets(report, budgets, { timings: !structuralOnly });
    if (structuralOnly) {
      const warnings = evaluateStartBudgets(report, budgets).filter((failure) => !failures.includes(failure));
      if (warnings.length > 0) console.warn(`Start timing budgets (advisory):\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
    }
    if (failures.length) {
      console.error(`Start budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Renderer bundle report: ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
