import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateGitBudgets } from "./git-budget.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, "reports", "git-report.json");
const budgets = JSON.parse(await readFile(join(root, "scripts", "performance-budgets.json"), "utf8"));
// The Git engine lives in Workspace Kit now, so its workload fixture is
// compiled the way the kit itself is: through the host bundler the loaders use.
const { bundleHostExtension } = await import(pathToFileURL(join(root, "dist-electron", "main", "extension-packages.js")).href);
const fixtureModule = join(await mkdtemp(join(tmpdir(), "tau-git-benchmark-")), "git-workload-fixture.cjs");
await writeFile(fixtureModule, await bundleHostExtension(join(root, "kits", "workspace", "git-workload-fixture.ts")));
const { createGitWorkloadFixture, measureGitWorkload } = createRequire(import.meta.url)(fixtureModule);
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
