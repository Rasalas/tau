import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ELECTRON = join(ROOT, "node_modules", ".bin", "electron");
const REPORT_PATH = join(ROOT, "reports", "start-report.json");
const BUDGET_PATH = join(ROOT, "scripts", "performance-budgets.json");

export function evaluateStartBudgets(report, budgets) {
  const failures = [];
  if (report.firstPaintMs === null) failures.push("firstPaintMs was not reported by the browser fixture");
  else if (report.firstPaintMs > budgets.firstPaintMs) failures.push(`firstPaintMs ${report.firstPaintMs} > budget ${budgets.firstPaintMs}`);
  if (report.externalRequests.length > budgets.externalNetworkRequests) {
    failures.push(`externalNetworkRequests ${report.externalRequests.length} > budget ${budgets.externalNetworkRequests}`);
  }
  for (const [component, measurement] of Object.entries(report.overlayComposition?.components ?? {})) {
    if (measurement.backdropBlur) failures.push(`${component} uses backdrop blur above the tested fallback`);
    if (measurement.measuredMs > budgets.overlayCompositionMs) {
      failures.push(`${component} overlay composition ${measurement.measuredMs}ms > budget ${budgets.overlayCompositionMs}`);
    }
  }
  return failures;
}

function runFixture() {
  const result = spawnSync(ELECTRON, [join(ROOT, "scripts", "start-fixture.cjs")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_IS_DEV: "0" },
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
    generatedAt: new Date().toISOString(),
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
  if (process.argv.includes("--check")) {
    const budgets = JSON.parse(await readFile(BUDGET_PATH, "utf8"));
    const failures = evaluateStartBudgets(report, budgets);
    if (failures.length) {
      console.error(`Start budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Start report: ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
