// Condense raw comparison runs into a Markdown/JSON pair suitable for Git.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median, round } from "./stats.mjs";
import { threadSwitchRows } from "./thread-switch.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const METRICS = [
  ["start: spawn to rail + composer (ms)", "startup.interactiveMs"],
  ["start: spawn to first paint (ms)", "startup.firstPaintMs"],
  ...threadSwitchRows().flatMap(([label, visible, settled]) => [[label.replace("visible · settled", "visible"), visible], [label.replace("visible · settled", "settled"), settled]]),
  ["turn: first text visible (ms)", "replay.firstTextMs"],
  ["turn: end visible after submit (ms)", "replay.endVisibleMs"],
  ["turn: scheduled replay duration (ms)", "replay.replayMs"],
  ...["frames", "p50", "p95", "p99", "max", "dropped"].map((key) => [`stream frames: ${key}${["p50", "p95", "p99", "max"].includes(key) ? " (ms)" : ""}`, `replay.streamFrames.${key}`]),
  ...["count", "totalMs", "maxMs"].map((key) => [`stream long tasks: ${key}`, `replay.streamLongTasks.${key}`]),
  ["long tasks after end (ms)", "replay.afterEndLongTasks.totalMs"],
  ...["received", "receivedKiB", "sent", "sentKiB", "httpRequests", "httpKiB"].map((key) => [`turn transfer: ${key}`, `replay.wire.${key}`]),
  ["idle CPU window (ms)", "idleCpu.windowMs"],
  ["idle CPU time, whole tree (ms)", "idleCpu.totalMs"],
  ["idle CPU, whole tree (% of one core)", "idleCpu.totalPercent"],
  ...["main", "backend", "renderer", "gpu", "utility", "other"].flatMap((role) => [
    [`idle CPU time, ${role} (ms)`, `idleCpu.byRoleMs.${role}`],
    [`idle CPU, ${role} (% of one core)`, `idleCpu.byRolePercent.${role}`],
  ]),
  ["load average at start (1 min)", "loadAtStart"],
  ["load average at switch launch (1 min)", "switchLoadAtStart"],
];

const at = (value, path) => path.split(".").reduce((child, key) => child?.[key], value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const distribution = (values) => values.length ? { n: values.length, median: round(median(values), 2), min: round(Math.min(...values), 2), max: round(Math.max(...values), 2) } : null;
const canonical = (value) => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

function readings(run, path) {
  if (path.startsWith("idleCpu.") && run.idleCpu?.complete !== true) return [];
  if (path.startsWith("threadSwitch.") && Array.isArray(run.switches)) {
    const [, kind, size, temperature, key] = path.split(".");
    return run.switches.filter((entry) => entry.kind === kind && entry.size === size && (temperature === "cold" ? entry.round === 0 : entry.round > 0) && !entry.result?.timedOut)
      .map((entry) => entry.result?.[key]).filter(finite);
  }
  const value = at(run, path);
  return finite(value) ? [value] : [];
}

export function summarizeReports(sources) {
  if (!sources.length) throw new Error("provide at least one comparison report");
  const first = sources[0].report;
  const apps = {};
  const results = {};
  const warnings = new Set();
  const provenance = [];
  for (const { file, report } of sources) {
    if (report.schemaVersion !== 1 || !report.apps || !report.results || Array.isArray(report.results) || !report.machine || !Number.isFinite(Date.parse(report.generatedAt))) {
      throw new Error(`${file}: expected a schema 1 comparison report with apps, results, machine and date`);
    }
    for (const key of ["machine", "window", "fixture", "turn"]) {
      if (canonical(report[key]) !== canonical(first[key])) throw new Error(`${file}: incompatible ${key}; summarize separately`);
    }
    if ((report.options?.idleMs ?? 5000) !== (first.options?.idleMs ?? 5000)) throw new Error(`${file}: incompatible idle window; summarize separately`);
    const loads = {};
    for (const [id, runs] of Object.entries(report.results)) {
      const app = report.apps[id];
      if (!app?.app || !app.commit || app.commit === "unknown" || !Array.isArray(runs)) throw new Error(`${file}: missing app identity, commit or raw runs for ${id}`);
      if (apps[id] && canonical(apps[id]) !== canonical(app)) throw new Error(`${file}: incompatible ${id} build or commit; summarize separately`);
      apps[id] = app;
      (results[id] ??= []).push(...runs);
      loads[id] = {
        runs: runs.length,
        start: distribution(runs.map((run) => run.loadAtStart).filter(finite)),
        switch: distribution(runs.map((run) => run.switchLoadAtStart).filter(finite)),
        completeCpuWindows: runs.filter((run) => run.idleCpu?.complete === true).length,
      };
      if (runs.some((run) => run.idleCpu?.complete === false)) warnings.add(`${id}: incomplete CPU windows excluded due to process churn`);
      if (runs.some((run) => run.switches?.some((entry) => entry.result?.timedOut))) warnings.add(`${id}: timed-out switches excluded`);
      if (runs.some((run) => run.threadSwitch && !Array.isArray(run.switches))) warnings.add(`${id}: legacy switch summaries used; warm samples are per-launch medians`);
    }
    provenance.push({ file: basename(file), generatedAt: report.generatedAt, options: report.options, loads });
  }
  const metrics = Object.fromEntries(Object.entries(results).map(([id, runs]) => [id, Object.fromEntries(METRICS.map(([, path]) => [path, distribution(runs.flatMap((run) => readings(run, path)))]))]));
  for (const id of Object.keys(apps)) {
    for (const path of ["startup.interactiveMs", "replay.endVisibleMs", "threadSwitch.codex.short.cold.visibleMs", "idleCpu.totalPercent"]) {
      if (!metrics[id][path]) warnings.add(`${id}: ${path} not measured`);
    }
  }
  if (!apps.tau || !apps.reference) warnings.add("Both Tau and the reference app are needed for a comparison claim");
  return {
    schemaVersion: 1,
    measuredFrom: sources.map(({ report }) => report.generatedAt).sort()[0],
    measuredThrough: sources.map(({ report }) => report.generatedAt).sort().at(-1),
    machine: first.machine, apps, window: first.window, fixture: first.fixture, turn: first.turn,
    sources: provenance, metrics, warnings: [...warnings],
  };
}

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
const cell = (stats) => stats ? `${stats.median} [${stats.min}, ${stats.max}]; n=${stats.n}` : "not measured";

export function renderSummary(summary) {
  const ids = Object.keys(summary.apps).sort((a, b) => a === "tau" ? -1 : b === "tau" ? 1 : a.localeCompare(b));
  const lines = [
    `# App comparison, ${summary.measuredThrough.slice(0, 10)}`, "",
    `Measured ${summary.measuredFrom} through ${summary.measuredThrough}.`, "",
    `Machine class: ${Object.entries(summary.machine).map(([key, value]) => `${key}=${escapeCell(value)}`).join(", ")}.`, "",
    "| App | Commit | Version | Electron | Build |", "| --- | --- | --- | --- | --- |",
    ...ids.map((id) => { const app = summary.apps[id]; return `| ${[app.app, app.commit, app.version ?? "unknown", app.electron ?? "unknown", app.build ?? "unknown"].map(escapeCell).join(" | ")} |`; }), "",
    "Values are median [minimum, maximum] across measured samples; n is the sample count. Warm-ups are excluded by the harness. Warm switches use each recorded switch when available. Frame percentiles remain per-turn measurements.", "",
    "Startup runs the production app entry with its host/server and seeded profile. Ready means the imported rail and composer are mounted. OS disk caches are not flushed. Turn duration ends when the final sentinel is visible; it does not time runtime completion.", "",
    "Idle CPU uses cumulative user + system time after a settling wait, excludes the replay CLI, and counts 100% as one fully occupied core. Process churn invalidates a window. BSD ps resolves CPU time to hundredths of a second; procps may resolve only whole seconds.", "",
    `| Metric | ${ids.map((id) => escapeCell(summary.apps[id].app)).join(" | ")} |`,
    `| --- | ${ids.map(() => "---:").join(" | ")} |`,
    ...METRICS.map(([label, path]) => `| ${escapeCell(label)} | ${ids.map((id) => cell(summary.metrics[id][path])).join(" | ")} |`), "",
    "## Source runs", "",
    "| Raw report | Date | App | Runs | Warm-ups | Mode | Start load | Switch load | Complete CPU windows |",
    "| --- | --- | --- | ---: | ---: | --- | --- | --- | ---: |",
    ...summary.sources.flatMap((source) => Object.entries(source.loads).map(([id, load]) => `| ${[source.file, source.generatedAt, summary.apps[id].app, load.runs, source.options?.warmup ?? "unknown", source.options?.threadSwitch ? "switch only" : "full", cell(load.start), cell(load.switch), load.completeCpuWindows].map(escapeCell).join(" | ")} |`)), "",
  ];
  if (summary.warnings.length) lines.push("## Missing evidence", "", ...summary.warnings.map((warning) => `- ${warning}`), "");
  return lines.join("\n");
}

function main(argv) {
  const files = [];
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      out = argv[++index];
      if (!out) throw new Error("--out needs a path stem");
    } else if (argv[index].startsWith("--")) throw new Error(`unknown flag ${argv[index]}`);
    else files.push(argv[index]);
  }
  if (new Set(files.map((file) => realpathSync(file))).size !== files.length) throw new Error("duplicate input report");
  const summary = summarizeReports(files.map((file) => ({ file, report: JSON.parse(readFileSync(file, "utf8")) })));
  const stem = resolve(out ?? `${ROOT}/docs/performance/compare-${summary.measuredThrough.slice(0, 10)}`).replace(/\.(md|json)$/u, "");
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(`${stem}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${stem}.md`, renderSummary(summary));
  console.log(`Comparison summary: ${stem}.md + .json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
