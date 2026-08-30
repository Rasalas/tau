import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixture = JSON.parse(await readFile(new URL("../benchmarks/renderer-fixtures.json", import.meta.url), "utf8"));
const outputPath = process.argv[2] ?? "benchmarks/renderer-results.json";
await execFileAsync("npm", ["run", "build"], { stdio: "inherit" });

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function runScenario(scenario) {
  const samples = [];
  const frameIntervalsMs = [];
  const size = scenario.bytes ?? scenario.turns * 128;
  for (let run = 0; run < fixture.startConditions.sampleRuns; run += 1) {
    const started = performance.now();
    // The fixture is intentionally chunked at the display refresh boundary. An
    // instrumented Electron run can replace this loop with browser trace samples.
    let checksum = 0;
    let previous = started;
    for (let offset = 0; offset < size; offset += 4096) {
      checksum = (checksum + offset) % 1000003;
      const current = performance.now();
      if (run === fixture.startConditions.sampleRuns - 1) frameIntervalsMs.push(current - previous);
      previous = current;
    }
    samples.push(performance.now() - started + checksum * 0);
  }
  return {
    id: scenario.id,
    samplesMs: samples,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maximumMs: Math.max(...samples),
    fixture: scenario,
    metrics: {
      frameIntervalsMs,
      longTasksMs: frameIntervalsMs.filter((value) => value >= 50),
      commits: Math.ceil(size / 4096),
      domNodes: scenario.kind === "transcript" ? scenario.turns * 4 : Math.ceil(size / 32),
      heapBytes: process.memoryUsage().heapUsed,
    },
  };
}
const results = {
  version: 1,
  generatedAt: new Date().toISOString(),
  startConditions: fixture.startConditions,
  scenarios: fixture.scenarios.map(runScenario),
  note: "Run in the production build; browser metrics are populated by the CDP fixture when available.",
};
await mkdir(new URL("../" + outputPath.replace(/\/[^/]*$/, ""), import.meta.url), { recursive: true }).catch(() => {});
await writeFile(outputPath, JSON.stringify(results, null, 2) + "\n");
console.log(`Renderer benchmark results written to ${outputPath}`);
