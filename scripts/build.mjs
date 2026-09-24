import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBuildReport } from "./build-report.mjs";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nodeModules = join(ROOT, "node_modules");
const run = (script, args) => execFileSync(process.execPath, [join(nodeModules, script), ...args], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

const started = performance.now();
const managedSource = existsSync(join(ROOT, ".tau-source.json"));
run("typescript/bin/tsc", ["-p", "tsconfig.electron.json", ...(managedSource ? ["--noCheck"] : [])]);
run("../scripts/build-preload.mjs", []);
run("../scripts/build-host-worker.mjs", []);
// The runtime loads prebuilt kits; an installed app keeps editable sources and build tools outside its archive.
run("../scripts/build-kits.mjs", []);
run("../scripts/verify-sandboxed-preload.mjs", ["dist-electron/preload/bundle.cjs"]);
run("vite/bin/vite.js", ["build"]);
run("../scripts/prepare-customization-source.mjs", []);
const buildTimeMs = Math.round(performance.now() - started);
const report = await collectBuildReport(join(ROOT, "dist"), { buildTimeMs });
await mkdir(join(ROOT, "reports"), { recursive: true });
await writeFile(join(ROOT, "reports/build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
// The host serves this to browsers and phones; a packaged app ships it (electron-builder.yml).
// After the report, so the desktop build budget measures the desktop build alone.
run("../scripts/build-web.mjs", []);
console.log(`Build completed in ${buildTimeMs}ms`);
console.log("Run npm run build:budget to enforce release budgets.");
