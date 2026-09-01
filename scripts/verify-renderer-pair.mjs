import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(process.argv[2] ?? "");
if (!manifestPath) throw new Error("pair manifest is required");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.status !== "accepted" || manifest.retryPolicy !== "never" || manifest.cherryPickPolicy !== "never") throw new Error("pair manifest is not an accepted no-retry/no-cherry-pick series");
if (JSON.stringify(manifest.order) !== JSON.stringify(["base", "current"]) || !manifest.seriesId || !manifest.loadPolicy?.invalidatePairSymmetrically) throw new Error("pair manifest has an invalid order or load policy");
const root = ROOT;
const archivePath = isAbsolute(manifest.archiveFile) ? manifest.archiveFile : join(root, manifest.archiveFile);
const archiveSha = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (archiveSha !== manifest.archiveSha256) throw new Error("pair archive hash mismatch");
const records = readFileSync(archivePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const scenarios = manifest.scenarioIds;
const totalRuns = manifest.startConditions.warmupRuns + manifest.startConditions.sampleRuns;
const expectedSamples = scenarios.length * totalRuns;
if (records.length !== expectedSamples * 2 + 2) throw new Error(`pair archive has ${records.length} records, expected ${expectedSamples * 2 + 2}`);
if (records.some((record, index) => record.seriesId !== manifest.seriesId || record.sequence !== index)) throw new Error("pair archive sequence is not contiguous or has the wrong series ID");
const preflights = records.filter((record) => record.event === "preflight");
if (preflights.length !== 2 || preflights[0].side !== "base" || preflights[1].side !== "current") throw new Error("pair preflight order is invalid");
for (const record of records) {
  const load = record.load;
  const maxLoad = Math.max(manifest.loadPolicy.minimumMaxLoadAverage1m, load.logicalCores * manifest.loadPolicy.maxLoadAverage1mFactor);
  if (!Number.isFinite(load.loadAverage1m) || load.loadAverage1m > maxLoad) throw new Error(`pair load policy failed for ${record.side}`);
  if (!record.startedAt) throw new Error("pair archive record has no start time");
}
for (const side of manifest.order) {
  const samples = records.filter((record) => record.event === "sample" && record.side === side);
  if (samples.length !== expectedSamples || new Set(samples.map((record) => record.runId)).size !== expectedSamples) throw new Error(`pair ${side} samples are incomplete or duplicated`);
  for (const scenario of scenarios) {
    const scenarioSamples = samples.filter((record) => record.scenario === scenario);
    if (scenarioSamples.length !== totalRuns || scenarioSamples.filter((record) => record.phase === "warmup").length !== manifest.startConditions.warmupRuns || scenarioSamples.filter((record) => record.phase === "sample").length !== manifest.startConditions.sampleRuns) throw new Error(`pair ${side} scenario ${scenario} has incomplete warmup/sample evidence`);
  }
  const reportInfo = manifest.reports[side];
  const reportPath = isAbsolute(reportInfo.path) ? reportInfo.path : join(root, reportInfo.path);
  if (createHash("sha256").update(readFileSync(reportPath)).digest("hex") !== reportInfo.sha256) throw new Error(`pair ${side} report hash mismatch`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.execution?.seriesId !== manifest.seriesId || report.execution?.seriesSide !== side) throw new Error(`pair ${side} report is not linked to the series`);
}
console.log(`Verified renderer pair series ${manifest.seriesId}: ${records.length} ordered records`);
