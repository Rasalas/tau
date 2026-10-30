import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comparePerformanceReports, comparisonHarnessFiles, comparisonPolicy } from "./performance-comparison.mjs";
import { resolveElectronRuntime } from "./electron-runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

// No dependency install or build happens between timed pairs. Every subprocess
// has a deadline, and CI also bounds the whole job to thirty minutes.
const deadline = Date.now() + 24 * 60_000;
function run(cwd, command, commandArgs, { timeout = 300_000, env = process.env } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Performance comparison exceeded its 24 minute limit");
  const result = spawnSync(command, commandArgs, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(timeout, remaining), maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout.trim();
}

const headCommit = flag("--head", run(ROOT, "git", ["rev-parse", "HEAD"]));
const baseCommit = flag("--base");
for (const [side, sha] of Object.entries({ base: baseCommit, head: headCommit })) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? "") || /^0+$/u.test(sha)) throw new Error(`--${side} requires an exact existing commit SHA`);
  run(ROOT, "git", ["cat-file", "-e", `${sha}^{commit}`]);
}
const outputDirectory = resolve(flag("--output-dir", join(ROOT, "reports")));
await mkdir(outputDirectory, { recursive: true });
const temporary = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "tau-performance-comparison-"));
const subjects = { base: join(temporary, "base"), head: join(temporary, "head") };
const added = [];
const provenance = { seriesId: randomUUID(), baseCommit, headCommit, harnessCommit: run(ROOT, "git", ["rev-parse", "HEAD"]) };
const runs = [];
let failure;
try {
  // Freeze the current measurement implementation and workload before building
  // either subject. Only benchmark entry points are overlaid, never product
  // components, build configuration, package manifests, or dependency locks.
  const fixture = JSON.parse(await readFile(join(ROOT, "benchmarks/renderer-fixtures.json"), "utf8"));
  fixture.startConditions = { ...fixture.startConditions, warmupRuns: comparisonPolicy.warmupRuns, sampleRuns: comparisonPolicy.sampleRuns };
  fixture.scenarios = comparisonPolicy.scenarios.map((id) => {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === id);
    if (!scenario) throw new Error(`Comparison fixture ${id} is missing`);
    return scenario;
  });
  const harnessBytes = new Map();
  for (const file of comparisonHarnessFiles) {
    harnessBytes.set(file, file === "benchmarks/renderer-fixtures.json"
      ? Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`) : await readFile(join(ROOT, file)));
  }
  const hash = createHash("sha256");
  provenance.harnessFileSha256 = {};
  for (const [file, bytes] of harnessBytes) {
    hash.update(file).update("\0").update(bytes).update("\0");
    provenance.harnessFileSha256[file] = createHash("sha256").update(bytes).digest("hex");
    const saved = join(outputDirectory, "comparison-harness", file);
    await mkdir(dirname(saved), { recursive: true });
    await writeFile(saved, bytes);
  }
  provenance.harnessSha256 = hash.digest("hex");
  provenance.dependencyLockSha256 = {};
  for (const side of ["base", "head"]) {
    const root = subjects[side];
    console.log(`Preparing ${side} ${side === "base" ? baseCommit : headCommit}`);
    run(ROOT, "git", ["worktree", "add", "--detach", root, side === "base" ? baseCommit : headCommit]);
    added.push(root);
    for (const [file, bytes] of harnessBytes) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), bytes);
    }
    provenance.dependencyLockSha256[side] = createHash("sha256").update(await readFile(join(root, "package-lock.json"))).digest("hex");
    run(root, "npm", ["ci", "--no-audit", "--no-fund"]);
    const vite = join(root, "node_modules", "vite", "bin", "vite.js");
    run(root, process.execPath, [vite, "build"]);
    run(root, process.execPath, [vite, "build", "--mode", "benchmark", "--outDir", join(root, "dist-benchmark"), "--emptyOutDir"]);
  }
  // Electron is measurement infrastructure here. Use the head's exact installed
  // binary for both bundles, including when the product upgrades Electron.
  // Each subject still builds against its own untouched dependency lockfile.
  provenance.measurementRuntime = {
    sourceCommit: headCommit,
    ...await resolveElectronRuntime(subjects.head, temporary, run),
  };
  const electronExecutable = provenance.measurementRuntime.executable;
  await writeFile(join(outputDirectory, "timing-comparison-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  for (let round = 0; round < comparisonPolicy.pairs; round += 1) {
    // Alternate AB/BA order so a warming or slowing runner does not always
    // favour the same side. Every side starts fresh Electron processes.
    for (const side of round % 2 === 0 ? ["base", "head"] : ["head", "base"]) {
      console.log(`Measuring pair ${round + 1}/${comparisonPolicy.pairs}, ${side}`);
      const root = subjects[side];
      const env = { ...process.env, TAU_BENCHMARK_ELECTRON: electronExecutable, TAU_RENDERER_SCENARIOS: comparisonPolicy.scenarios.join(","), TAU_BENCHMARK_SUBJECT_COMMIT: provenance[`${side}Commit`], TAU_BENCHMARK_HARNESS_COMMIT: provenance.harnessCommit, TAU_BENCHMARK_PROFILE_ROOT: join(temporary, "profiles", `${round}-${side}`) };
      // Ignore ambient archive/historical harness settings. This series owns
      // all of its reports and their metadata.
      for (const key of ["TAU_BENCHMARK_ARCHIVE", "TAU_BENCHMARK_HARNESS_PATCH_FILE", "TAU_BENCHMARK_HARNESS_PATCH_SHA256", "TAU_BENCHMARK_SERIES_ID", "TAU_BENCHMARK_SERIES_SIDE"]) delete env[key];
      const rendererPath = join(outputDirectory, `comparison-${round}-${side}-renderer.json`);
      run(root, process.execPath, [join(root, "scripts/renderer-benchmark.mjs"), "--no-build", rendererPath], { env, timeout: 180_000 });
      const starts = [];
      for (let sample = 0; sample < comparisonPolicy.warmupRuns + comparisonPolicy.sampleRuns; sample += 1) {
        run(root, process.execPath, [join(root, "scripts/start-report.mjs"), "--check-structural"], { env, timeout: 45_000 });
        if (sample >= comparisonPolicy.warmupRuns) {
          const startPath = join(root, "reports/start-report.json");
          starts.push(JSON.parse(await readFile(startPath, "utf8")));
          await copyFile(startPath, join(outputDirectory, `comparison-${round}-${side}-start-${sample}.json`));
        }
      }
      runs.push({ round, side, seriesId: provenance.seriesId, harnessSha256: provenance.harnessSha256, renderer: JSON.parse(await readFile(rendererPath, "utf8")), starts });
    }
  }
  const result = comparePerformanceReports(runs, provenance);
  await writeFile(join(outputDirectory, "timing-comparison.json"), `${JSON.stringify(result, null, 2)}\n`);
  for (const metric of result.metrics) console.log(`${metric.failed ? "FAIL" : "PASS"} ${metric.name}: ${metric.baseMedianMs.toFixed(1)} → ${metric.headMedianMs.toFixed(1)} ms, ${(metric.relativeIncrease * 100).toFixed(1)}% paired median increase`);
  if (result.failures.length > 0) throw new Error(`Timing regressions: ${result.failures.join(", ")}`);
} catch (error) {
  failure = error;
  await writeFile(join(outputDirectory, "timing-comparison-error.json"), `${JSON.stringify({ error: error.message, provenance, completedRuns: runs.length }, null, 2)}\n`);
} finally {
  for (const root of added.reverse()) {
    // Cleanup is required even after the measurement deadline.
    const result = spawnSync("git", ["worktree", "remove", "--force", root], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0) failure ??= new Error(`Could not remove comparison worktree ${root}: ${result.stderr}`);
  }
  await rm(temporary, { recursive: true, force: true });
}
if (failure) throw failure;
