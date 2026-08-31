import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const subject = process.argv[2] ?? "6ddb4541b02410fa8c462dca4b9bb3b9969d5756";
const nodeModules = resolve(process.argv[3] ?? join(ROOT, "node_modules"));
const fixture = JSON.parse(await readFile(join(ROOT, "benchmarks/renderer-fixtures.json"), "utf8"));
const seriesId = `renderer-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
const archiveFile = join(ROOT, "reports", `${seriesId}.jsonl`);
const baseReport = join(ROOT, "reports", `${seriesId}-base.json`);
const currentReport = join(ROOT, "reports", `${seriesId}-current.json`);
const manifestFile = join(ROOT, "reports", `${seriesId}.json`);
const sampleCount = fixture.scenarios.length * (fixture.startConditions.warmupRuns + fixture.startConditions.sampleRuns);
const loadPolicy = { maxLoadAverage1mFactor: 2, minimumMaxLoadAverage1m: 4, measuredBeforeEachSide: true, invalidatePairSymmetrically: true };

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args, cwd = ROOT, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "inherit" });
}

function loadMetadata() {
  const logicalCores = os.cpus().length;
  return { logicalCores, loadAverage1m: os.loadavg()[0], loadAverage5m: os.loadavg()[1] };
}

function maxLoad(metadata) {
  return Math.max(loadPolicy.minimumMaxLoadAverage1m, metadata.logicalCores * loadPolicy.maxLoadAverage1mFactor);
}

function assertLoad(side, metadata) {
  if (!Number.isFinite(metadata.loadAverage1m) || metadata.loadAverage1m > maxLoad(metadata)) {
    throw new Error(`pair load preflight failed for ${side}: ${metadata.loadAverage1m} > ${maxLoad(metadata)}`);
  }
}

function appendPreflight(side, sequence) {
  const metadata = loadMetadata();
  assertLoad(side, metadata);
  appendFileSync(archiveFile, `${JSON.stringify({ event: "preflight", seriesId, side, sequence, startedAt: new Date().toISOString(), load: metadata })}\n`);
}

await mkdir(dirname(archiveFile), { recursive: true });
const manifestBase = {
  schemaVersion: 1,
  status: "accepted",
  seriesId,
  order: ["base", "current"],
  subjectCommit: subject,
  startConditions: fixture.startConditions,
  scenarioIds: fixture.scenarios.map(({ id }) => id),
  loadPolicy,
  retryPolicy: "never",
  cherryPickPolicy: "never",
  archiveFile: archiveFile.slice(ROOT.length + 1),
  reports: { base: baseReport.slice(ROOT.length + 1), current: currentReport.slice(ROOT.length + 1) },
};

try {
  appendPreflight("base", 0);
  run("node", ["scripts/reproduce-renderer-baseline.mjs", subject, `/tmp/${seriesId}-base`, nodeModules, baseReport], ROOT, {
    ...process.env,
    TAU_BENCHMARK_SERIES_ID: seriesId,
    TAU_BENCHMARK_ARCHIVE: archiveFile,
    TAU_BENCHMARK_SEQUENCE_OFFSET: "1",
  });
  appendPreflight("current", sampleCount + 1);
  run("npm", ["run", "build"], ROOT);
  run("git", ["restore", "reports/build-report.json"], ROOT);
  run("node", ["scripts/renderer-benchmark.mjs", "--no-build", "--check", currentReport], ROOT, {
    ...process.env,
    TAU_BENCHMARK_SERIES_ID: seriesId,
    TAU_BENCHMARK_SERIES_SIDE: "current",
    TAU_BENCHMARK_ARCHIVE: archiveFile,
    TAU_BENCHMARK_SEQUENCE_OFFSET: String(sampleCount + 2),
  });
  const manifest = {
    ...manifestBase,
    archiveSha256: hashFile(archiveFile),
    reports: {
      base: { path: manifestBase.reports.base, sha256: hashFile(baseReport) },
      current: { path: manifestBase.reports.current, sha256: hashFile(currentReport) },
    },
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  run("node", ["scripts/verify-renderer-pair.mjs", manifestFile], ROOT);
  console.log(`Renderer pair series: ${manifestFile}`);
} catch (error) {
  const invalid = { ...manifestBase, status: "invalid", failure: String(error?.message ?? error), archiveSha256: existsSync(archiveFile) ? hashFile(archiveFile) : null };
  await writeFile(manifestFile, `${JSON.stringify(invalid, null, 2)}\n`);
  throw error;
}
