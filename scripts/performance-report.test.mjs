import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classifyAsset, evaluateBuildBudgets } from "./build-report.mjs";
import { evaluateStartBudgets } from "./start-report.mjs";
import { evaluateRendererBudgets } from "./renderer-budget.mjs";
import { evaluateHostBudgets } from "./host-budget.mjs";
import { evaluateGitBudgets } from "./git-budget.mjs";

describe("performance report checks", () => {
  it("separates entry assets from demand-loaded chunks", () => {
    const initial = new Set(["index-abc.js", "index-def.css"]);
    expect(classifyAsset("/dist/assets/index-abc.js", initial)).toEqual({ kind: "javascript", phase: "initial" });
    expect(classifyAsset("/dist/assets/Review-x.js", initial)).toEqual({ kind: "javascript", phase: "lazy" });
    expect(classifyAsset("/dist/assets/index-def.css", initial)).toEqual({ kind: "css", phase: "initial" });
    expect(classifyAsset("/dist/assets/index-ghi.js.map", initial)).toEqual({ kind: "sourcemaps", phase: "lazy" });
  });

  it("fails a build budget when a measured value regresses", () => {
    const report = {
      initial: { javascript: { bytes: 20, gzipBytes: 20 }, css: { bytes: 1, gzipBytes: 1 } },
      lazy: { javascript: { bytes: 1, gzipBytes: 1 } },
      buildTimeMs: 1,
      overlayComposition: { backdropBlur: false },
    };
    expect(evaluateBuildBudgets(report, { initialJavascriptBytes: 10 })).toEqual([
      "initial.javascript.bytes 20 > budget 10",
    ]);
  });

  it("rejects a missing build-time measurement", () => {
    const report = {
      initial: { javascript: { bytes: 1, gzipBytes: 1 }, css: { bytes: 1, gzipBytes: 1 } },
      lazy: { javascript: { bytes: 1, gzipBytes: 1 } },
      buildTimeMs: null,
      overlayComposition: { backdropBlur: false },
    };
    expect(evaluateBuildBudgets(report, { buildTimeMs: 10 })).toContain("buildTimeMs was not reported by the build fixture");
  });

  it("keeps first paint independent from external fonts and blur composition", async () => {
    const [html, styles] = await Promise.all([
      readFile(new URL("../index.html", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8"),
    ]);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/u);
    expect(styles).not.toMatch(/@import\s+url\(/u);
    expect(styles).not.toMatch(/backdrop-filter\s*:/u);
  });

  it("fails startup when paint is missing or external requests appear", () => {
    expect(evaluateStartBudgets({ firstPaintMs: null, externalRequests: [] }, { firstPaintMs: 100, externalNetworkRequests: 0 })).toContain(
      "firstPaintMs was not reported by the browser fixture",
    );
    expect(evaluateStartBudgets({ firstPaintMs: 10, externalRequests: [{ name: "https://fonts.example" }] }, { firstPaintMs: 100, externalNetworkRequests: 0 })).toContain(
      "externalNetworkRequests 1 > budget 0",
    );
  });

  it("fails inconsistent host phases and a slow warm switch", () => {
    const failures = evaluateHostBudgets({ mode: "full", summaries: { "warm-switch": { median: 100, p95: 200, maximum: 210 } }, phases: [{ scenario: "warm-switch", totalMs: 10, phases: [{ name: "stale", durationMs: 100 }] }] });
    expect(failures).toHaveLength(2);
  });

  it("fails Git fan-out and missing measurements", () => {
    const failures = evaluateGitBudgets({
      baselineSubprocesses: 6, coordinatedSubprocesses: 7, overlappingRefreshSubprocesses: 7,
      maxParallelSubprocesses: 5, manyProjectMaxParallelSubprocesses: 5, slowCommandMs: 200,
      manyProjectBranchP95Ms: Number.NaN, bytesRead: 10, slowCommandState: "ready",
    }, {
      gitSubprocesses: 6, gitOverlapSubprocesses: 6, gitMaxParallelSubprocesses: 4,
      gitSlowCommandMs: 150, gitManyProjectP95Ms: 500, gitBytesRead: 5,
    });
    expect(failures.length).toBeGreaterThanOrEqual(8);
  });

  it("fails renderer budgets for slow frames and unbounded DOM", () => {
    const report = { scenarios: [{
      id: "regression",
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 40 },
      longTasksMs: { maximum: 80 },
      commitDurationsMs: { p95: 30 },
      domNodes: 9_000,
    }] };
    const failures = evaluateRendererBudgets(report, {
      rendererFrameP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
    });
    expect(failures).toHaveLength(4);
  });

  it("rejects missing renderer scenarios and measurements", () => {
    const failures = evaluateRendererBudgets({ scenarios: [{ id: "partial", longTaskObserverSupported: false, frameIntervalsMs: {}, longTasksMs: {}, commitDurationsMs: {} }] }, {
      rendererFrameP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererRequiredScenarios: ["required"],
    });
    expect(failures).toHaveLength(6);
  });
});
