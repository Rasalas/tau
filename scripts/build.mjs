import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBuildReport } from "./build-report.mjs";
import { measureReference } from "./build-time.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nodeModules = join(ROOT, "node_modules");
const run = (script, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(nodeModules, script), ...args], {
    cwd: ROOT, stdio: "inherit", env: process.env,
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${script} failed (${signal ?? code})`)));
});
const parallel = async (jobs) => {
  // Wait for every writer even on failure, before another build can reuse its outputs.
  const results = await Promise.allSettled(jobs);
  for (const result of results) if (result.status === "rejected") throw result.reason;
};

// `--reference` brackets the build with a fixed workload so the budget can compare
// build time across machines of different speed (scripts/build-time.mjs).
const reference = process.argv.includes("--reference");
const referenceSamplesMs = reference ? measureReference() : [];
const started = performance.now();
// `npm run typecheck` checks every target separately, including in CI. Build emits
// the host as the editable-source build already does, without repeating that check.
await parallel([
  run("typescript/bin/tsc", ["-p", "tooling/tsconfig.electron.json", "--noCheck"]),
  run("../scripts/build-preload.mjs", []),
  run("../scripts/build-host-worker.mjs", []),
  // This copies source inputs only, so it can overlap compilation instead of
  // extending the critical path after the renderer and kits are finished.
  run("../scripts/prepare-customization-source.mjs", []),
]);
// The runtime loads prebuilt kits; an installed app keeps editable sources and build tools outside its archive.
await run("../scripts/verify-sandboxed-preload.mjs", ["dist-electron/preload/bundle.cjs"]);
await parallel([run("../scripts/build-kits.mjs", []), run("vite/bin/vite.js", ["build"])]);
const buildTimeMs = Math.round(performance.now() - started);
if (reference) referenceSamplesMs.push(...measureReference());
const report = await collectBuildReport(join(ROOT, "dist"), { buildTimeMs, referenceSamplesMs, kitsDirectory: join(ROOT, "dist-kits") });
await mkdir(join(ROOT, "reports"), { recursive: true });
await writeFile(join(ROOT, "reports/build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
// The host serves this to browsers and phones; a packaged app ships it (tooling/electron-builder.yml).
// After the report, so the desktop build budget measures the desktop build alone.
await run("../scripts/build-web.mjs", []);
// The extension API's declarations, which a release ships for `tau kit new`; outside the budget like the web build.
await run("../scripts/build-types.mjs", []);
console.log(`Build completed in ${buildTimeMs}ms${reference ? `, reference workload ${referenceSamplesMs.join("/")}ms` : ""}`);
console.log("Run npm run build:budget to enforce release budgets.");
