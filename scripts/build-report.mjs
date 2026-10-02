import { gzipSync } from "node:zlib";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBuildTime, median, readHistory } from "./build-time.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_DIST = join(ROOT, "dist");
const DEFAULT_KITS = join(ROOT, "dist-kits");
const REPORT_PATH = join(ROOT, "reports", "build-report.json");
const BUDGET_PATH = join(HERE, "performance-budgets.json");

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files;
}

function assetKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".js" || extension === ".mjs") return "javascript";
  if (extension === ".css") return "css";
  if (extension === ".map") return "sourcemaps";
  return undefined;
}

export function classifyAsset(path, initialAssets) {
  const kind = assetKind(path);
  if (!kind) return undefined;
  return { kind, phase: initialAssets.has(basename(path)) ? "initial" : "lazy" };
}

function emptyTotals() {
  return { bytes: 0, gzipBytes: 0, files: 0 };
}

function initialAssetsFromHtml(html) {
  const assets = new Set();
  // `./assets/x.js` in the desktop build, `/assets/x.js` in the web one.
  for (const match of html.matchAll(/(?:src|href)="(?:\.?\/)?(?:assets\/)?([^"?#]+)"/gu)) {
    assets.add(match[1]);
  }
  return assets;
}

/**
 * The kits' desktop halves: every window start moves all of them from the host
 * and imports them, so their size is start-up time as much as `dist/` is.
 */
export async function collectKitReport(kitsDirectory = DEFAULT_KITS) {
  const desktop = emptyTotals();
  for (const name of await readdir(kitsDirectory).catch(() => [])) {
    const code = await readFile(join(kitsDirectory, name, "desktop.js")).catch(() => undefined);
    if (!code) continue;
    desktop.bytes += code.length;
    desktop.gzipBytes += gzipSync(code).length;
    desktop.files += 1;
  }
  return { desktop };
}

export async function collectBuildReport(distDirectory = DEFAULT_DIST, { buildTimeMs, referenceSamplesMs, kitsDirectory } = {}) {
  const html = await readFile(join(distDirectory, "index.html"), "utf8");
  const initialAssets = initialAssetsFromHtml(html);
  const totals = {
    initial: { javascript: emptyTotals(), css: emptyTotals(), sourcemaps: emptyTotals() },
    lazy: { javascript: emptyTotals(), css: emptyTotals(), sourcemaps: emptyTotals() },
  };
  const assets = [];
  for (const path of await filesIn(distDirectory)) {
    const classification = classifyAsset(path, initialAssets);
    if (!classification) continue;
    const bytes = (await stat(path)).size;
    const entry = {
      file: relative(distDirectory, path).replaceAll("\\", "/"),
      kind: classification.kind,
      phase: classification.phase,
      bytes,
      gzipBytes: gzipSync(await readFile(path)).length,
    };
    assets.push(entry);
    const total = totals[classification.phase][classification.kind];
    total.bytes += entry.bytes;
    total.gzipBytes += entry.gzipBytes;
    total.files += 1;
  }
  assets.sort((left, right) => left.file.localeCompare(right.file));
  const overlayBlur = /backdrop-filter\s*:/u.test(await readFile(join(ROOT, "src/renderer/styles.css"), "utf8"));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buildTimeMs: buildTimeMs ?? null,
    ...(referenceSamplesMs?.length ? { buildTime: { referenceSamplesMs, referenceMs: Math.round(median(referenceSamplesMs)) } } : {}),
    sourcemaps: assets.filter((asset) => asset.kind === "sourcemaps").length > 0,
    initial: totals.initial,
    lazy: totals.lazy,
    assets,
    ...(kitsDirectory ? { kits: await collectKitReport(kitsDirectory) } : {}),
    overlayComposition: {
      strategy: overlayBlur ? "backdrop-blur" : "opaque-scrim",
      backdropBlur: overlayBlur,
      budgetMs: 4,
    },
  };
}

/** `history` is the recent main runs (scripts/build-time.mjs); without it only the cap applies. */
export function checkBuildTime(report, budgets, history = []) {
  return evaluateBuildTime(
    { buildTimeMs: report.buildTimeMs, referenceMs: report.buildTime?.referenceMs },
    budgets.buildTimeMs,
    budgets.buildTimeReference,
    history,
  );
}

export function evaluateBuildBudgets(report, budgets, history = []) {
  const failures = report.buildTimeMs == null && budgets.buildTimeMs !== undefined
    ? ["buildTimeMs was not reported by the build fixture"]
    : [];
  const checks = [
    ["initial.javascript.bytes", report.initial.javascript.bytes, budgets.initialJavascriptBytes],
    ["initial.javascript.gzipBytes", report.initial.javascript.gzipBytes, budgets.initialJavascriptGzipBytes],
    ["initial.css.bytes", report.initial.css.bytes, budgets.initialCssBytes],
    ["initial.css.gzipBytes", report.initial.css.gzipBytes, budgets.initialCssGzipBytes],
    ["total.javascript.bytes", report.initial.javascript.bytes + report.lazy.javascript.bytes, budgets.totalJavascriptBytes],
    ["total.javascript.gzipBytes", report.initial.javascript.gzipBytes + report.lazy.javascript.gzipBytes, budgets.totalJavascriptGzipBytes],
    ["kits.desktop.bytes", report.kits?.desktop.bytes, budgets.kitDesktopJavascriptBytes],
    ["overlayCompositionMs", report.overlayComposition.backdropBlur ? budgets.overlayCompositionMs + 1 : 0, budgets.overlayCompositionMs],
  ];
  return failures.concat(checks
    .filter(([, actual, budget]) => budget !== undefined && actual != null && actual > budget)
    .map(([name, actual, budget]) => `${name} ${actual} > budget ${budget}`), checkBuildTime(report, budgets, history).failures);
}

/** One line for the log and the job summary: raw time, speed, and what it was held to. */
export function describeBuildTime(report) {
  const time = report.buildTime;
  if (report.buildTimeMs == null) return "Build time: not measured";
  if (!time?.normalizedMs) return `Build time: ${report.buildTimeMs} ms (no reference measured, raw budget)`;
  const trend = time.history
    ? `, median of the last ${time.history.runs} main runs ${time.history.medianMs} ms (limit ${time.history.limitMs} ms)`
    : ", no history";
  return `Build time: ${report.buildTimeMs} ms raw, reference ${time.referenceMs} ms (speed ${time.speedFactor}), ${time.normalizedMs} ms at reference speed (cap ${time.capMs} ms)${trend}`;
}

async function main() {
  const dist = process.env.TAU_DIST ? join(ROOT, process.env.TAU_DIST) : DEFAULT_DIST;
  let buildTimeMs = process.env.TAU_BUILD_TIME_MS ? Number(process.env.TAU_BUILD_TIME_MS) : undefined;
  let referenceSamplesMs = process.env.TAU_BUILD_REFERENCE_MS ? [Number(process.env.TAU_BUILD_REFERENCE_MS)] : undefined;
  if (process.argv.includes("--check")) {
    try {
      const previous = JSON.parse(await readFile(REPORT_PATH, "utf8"));
      buildTimeMs ??= previous.buildTimeMs ?? undefined;
      referenceSamplesMs ??= previous.buildTime?.referenceSamplesMs;
    } catch {
      // The evaluator below rejects a missing measurement.
    }
  }
  const report = await collectBuildReport(dist, { buildTimeMs, referenceSamplesMs, kitsDirectory: DEFAULT_KITS });
  await mkdir(join(ROOT, "reports"), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--check")) {
    const budgets = JSON.parse(await readFile(BUDGET_PATH, "utf8"));
    const history = await readHistory(process.env.TAU_BUILD_TIME_HISTORY);
    const failures = evaluateBuildBudgets(report, budgets, history);
    const { summary } = checkBuildTime(report, budgets, history);
    if (summary) report.buildTime = { ...report.buildTime, ...summary };
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    const line = describeBuildTime(report);
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    if (failures.length) {
      console.error(`Build budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Build report: ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
