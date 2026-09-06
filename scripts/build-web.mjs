// Builds the browser client into dist-web/ and holds it to its own budget.
// The desktop bundle is measured by build-report.mjs; this is the same report
// shape over a different directory, because the two ship separately.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBuildReport, evaluateBuildBudgets } from "./build-report.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-web");
const REPORT_PATH = join(ROOT, "reports", "build-web-report.json");
const BUDGET_PATH = join(ROOT, "scripts", "performance-budgets.json");

const started = performance.now();
execFileSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.web.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
// Vite names the output after its input; the host serves it as the index.
await rename(join(DIST, "index.web.html"), join(DIST, "index.html"));
const buildTimeMs = Math.round(performance.now() - started);

const report = await collectBuildReport(DIST, { buildTimeMs });
await mkdir(join(ROOT, "reports"), { recursive: true });
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Web build completed in ${buildTimeMs}ms: ${REPORT_PATH}`);

if (process.argv.includes("--check")) {
  const budgets = JSON.parse(await readFile(BUDGET_PATH, "utf8")).web;
  if (!budgets) {
    console.error("Web budget failed: performance-budgets.json has no \"web\" section");
    process.exitCode = 1;
  } else {
    const failures = evaluateBuildBudgets(report, budgets);
    if (failures.length) {
      console.error(`Web build budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
}
