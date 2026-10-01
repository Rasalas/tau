// Build time relative to the machine's speed, and against the recent runs on main.
// See "Build time on shared runners" in docs/PERFORMANCE.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORT_PATH = join(ROOT, "reports", "build-report.json");

const WORDS = ["const", "value", "items", "render", "state", "props", "index", "result", "count", "next", "thread", "host"];

function isNameStart(code) {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code === 36;
}

/**
 * A fixed, compiler-shaped workload: generate source, scan it, build a tree, rename,
 * print and compress. Dependency-free, so a toolchain upgrade does not move it.
 */
export function referenceWorkload(statements = 80_000) {
  let seed = 7;
  const random = (limit) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((seed / 2_147_483_648) * limit);
  };
  const lines = [];
  for (let index = 0; index < statements; index += 1) {
    const word = WORDS[random(WORDS.length)];
    lines.push(random(5) === 0
      ? `${word}${index % 97}(${random(1000)}, "${WORDS[random(WORDS.length)]}");`
      : `${word} = ${word}_${index % 31} * ${random(100)} + ${WORDS[random(WORDS.length)]}.length;`);
  }
  const source = lines.join("\n");

  const tokens = [];
  for (let at = 0; at < source.length;) {
    const code = source.charCodeAt(at);
    let end = at + 1;
    if (isNameStart(code)) {
      while (end < source.length && (isNameStart(source.charCodeAt(end)) || (source.charCodeAt(end) >= 48 && source.charCodeAt(end) <= 57))) end += 1;
      tokens.push({ kind: "name", text: source.slice(at, end) });
    } else if (code >= 48 && code <= 57) {
      while (end < source.length && source.charCodeAt(end) >= 48 && source.charCodeAt(end) <= 57) end += 1;
      tokens.push({ kind: "number", text: source.slice(at, end) });
    } else if (code === 34) {
      end = source.indexOf('"', at + 1) + 1;
      tokens.push({ kind: "string", text: source.slice(at, end) });
    } else if (code !== 10 && code !== 32) {
      tokens.push({ kind: "punct", text: source[at] });
    }
    at = end;
  }

  const body = [];
  let statement = { children: [] };
  for (const token of tokens) {
    if (token.text === ";") {
      body.push(statement);
      statement = { children: [] };
    } else statement.children.push(token);
  }

  const renames = new Map();
  const printed = body.map((node) => node.children.map((token) => {
    if (token.kind !== "name") return token.text;
    let short = renames.get(token.text);
    if (!short) {
      short = `_${renames.size.toString(36)}`;
      renames.set(token.text, short);
    }
    return short;
  }).join(" ")).join(";\n");

  return gzipSync(printed).length + renames.size;
}

export function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Times `samples` runs of the workload after one warm-up run. */
export function measureReference({ samples = 5, workload = referenceWorkload } = {}) {
  workload();
  const samplesMs = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    workload();
    samplesMs.push(Math.round(performance.now() - started));
  }
  return samplesMs;
}

/**
 * Checks a build's time against the absolute cap and, given history, against the recent median.
 * `config` is `buildTimeReference` from performance-budgets.json.
 */
export function evaluateBuildTime({ buildTimeMs, referenceMs }, capMs, config, history = []) {
  const failures = [];
  if (capMs === undefined || buildTimeMs == null) return { failures, summary: undefined };
  if (!config || !(referenceMs > 0)) {
    if (buildTimeMs > capMs) failures.push(`buildTimeMs ${buildTimeMs} > budget ${capMs}`);
    return { failures, summary: undefined };
  }
  const speedFactor = config.referenceMs / referenceMs;
  const normalizedMs = Math.round(buildTimeMs * speedFactor);
  // A fast machine is held to the raw budget; a slow one gets bounded credit.
  const cappedMs = Math.round(buildTimeMs * Math.min(1, Math.max(config.minSpeedFactor, speedFactor)));
  if (cappedMs > capMs) {
    failures.push(`buildTimeMs ${buildTimeMs} is ${cappedMs} at reference speed > budget ${capMs} (reference ${referenceMs} ms, runner ${config.referenceMs} ms)`);
  }
  const recent = history
    .filter((entry) => entry.epoch === config.historyEpoch && entry.buildTimeMs > 0 && entry.referenceMs > 0)
    .slice(-config.historyRuns)
    .map((entry) => entry.buildTimeMs * (config.referenceMs / entry.referenceMs));
  let trend;
  if (recent.length >= config.historyMinRuns) {
    const medianMs = Math.round(median(recent));
    const limitMs = Math.round(medianMs * (1 + config.historyMargin));
    trend = { runs: recent.length, medianMs, limitMs };
    if (normalizedMs > limitMs) {
      failures.push(`buildTimeMs at reference speed ${normalizedMs} > ${limitMs}, the median of the last ${recent.length} main runs (${medianMs}) + ${Math.round(config.historyMargin * 100)}%`);
    }
  }
  return {
    failures,
    summary: { referenceMs, speedFactor: Math.round(speedFactor * 1000) / 1000, normalizedMs, cappedMs, capMs, history: trend ?? null },
  };
}

/** Appends one run and keeps the newest `runs` entries of the current epoch. */
export function appendHistory(history, entry, config) {
  return [...history.filter((item) => item.epoch === config.historyEpoch), { ...entry, epoch: config.historyEpoch }]
    .slice(-config.historyRuns);
}

export async function readHistory(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function record(path) {
  const report = await readFile(REPORT_PATH, "utf8").then(JSON.parse, () => ({}));
  const referenceMs = report.buildTime?.referenceMs;
  if (!(report.buildTimeMs > 0) || !(referenceMs > 0)) {
    console.log("Build-time history: the report has no calibrated build time; nothing recorded");
    return;
  }
  const budgets = JSON.parse(await readFile(join(ROOT, "scripts", "performance-budgets.json"), "utf8"));
  const history = appendHistory(await readHistory(path), {
    commit: process.env.GITHUB_SHA ?? null,
    recordedAt: report.generatedAt,
    buildTimeMs: report.buildTimeMs,
    referenceMs,
    cpu: cpus()[0]?.model ?? "unknown",
  }, budgets.buildTimeReference);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`Build-time history: ${history.length} runs in ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, path] = process.argv.slice(2);
  if (command === "record" && path) await record(path);
  else if (command === "reference") console.log(JSON.stringify(measureReference({ samples: Number(path) || 5 })));
  else {
    console.error("Usage: node scripts/build-time.mjs record <history.json> | reference [samples]");
    process.exitCode = 1;
  }
}
