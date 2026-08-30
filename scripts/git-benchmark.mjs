import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateGitBudgets } from "./git-budget.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, "reports", "git-report.json");
const budgets = JSON.parse(await readFile(join(root, "scripts", "performance-budgets.json"), "utf8"));
const { createGitWorkloadFixture, measureGitWorkload } = await import(pathToFileURL(join(root, "dist-electron", "main", "git-workload-fixture.js")).href);
const fixture = await createGitWorkloadFixture(1_200);
try {
  const workload = await measureGitWorkload(fixture.cwd);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startConditions: { files: 1_200, maxConcurrency: 4, build: "production Electron host modules" },
    workload,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (check) {
    const failures = evaluateGitBudgets(workload, budgets);
    if (failures.length > 0) {
      console.error(`Git budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Git report: ${output}`);
} finally {
  await fixture.cleanup();
}
