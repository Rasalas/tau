import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_DIST = join(ROOT, "dist");
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

export async function collectBuildReport(distDirectory = DEFAULT_DIST, { buildTimeMs } = {}) {
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
    sourcemaps: assets.filter((asset) => asset.kind === "sourcemaps").length > 0,
    initial: totals.initial,
    lazy: totals.lazy,
    assets,
    overlayComposition: {
      strategy: overlayBlur ? "backdrop-blur" : "opaque-scrim",
      backdropBlur: overlayBlur,
      budgetMs: 4,
    },
  };
}

export function evaluateBuildBudgets(report, budgets) {
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
    ["buildTimeMs", report.buildTimeMs, budgets.buildTimeMs],
    ["overlayCompositionMs", report.overlayComposition.backdropBlur ? budgets.overlayCompositionMs + 1 : 0, budgets.overlayCompositionMs],
  ];
  return failures.concat(checks
    .filter(([, actual, budget]) => budget !== undefined && actual != null && actual > budget)
    .map(([name, actual, budget]) => `${name} ${actual} > budget ${budget}`));
}

async function main() {
  const dist = process.env.TAU_DIST ? join(ROOT, process.env.TAU_DIST) : DEFAULT_DIST;
  let buildTimeMs = process.env.TAU_BUILD_TIME_MS ? Number(process.env.TAU_BUILD_TIME_MS) : undefined;
  if (buildTimeMs === undefined && process.argv.includes("--check")) {
    try {
      buildTimeMs = JSON.parse(await readFile(REPORT_PATH, "utf8")).buildTimeMs ?? undefined;
    } catch {
      // The evaluator below rejects a missing measurement.
    }
  }
  const report = await collectBuildReport(dist, { buildTimeMs });
  await mkdir(join(ROOT, "reports"), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--check")) {
    const budgets = JSON.parse(await readFile(BUDGET_PATH, "utf8"));
    const failures = evaluateBuildBudgets(report, budgets);
    if (failures.length) {
      console.error(`Build budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Build report: ${REPORT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
