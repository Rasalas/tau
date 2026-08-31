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
    const failures = evaluateHostBudgets({ mode: "full", summaries: { bootstrap: { median: 100, p95: 100, maximum: 100 }, "cold-switch": { median: 100, p95: 100, maximum: 100 }, "warm-switch": { median: 100, p95: 200, maximum: 210 } }, phases: [{ scenario: "warm-switch", totalMs: 10, phases: [{ name: "stale", durationMs: 100 }] }], background: [{ name: "branch", durationMs: 10 }] });
    expect(failures).toHaveLength(2);
  });

  it("fails a slow host bootstrap instead of hiding branch work", () => {
    const failures = evaluateHostBudgets({ mode: "full", summaries: {
      bootstrap: { median: 2_100, p95: 2_300, maximum: 2_300 },
      "cold-switch": { median: 100, p95: 100, maximum: 100 },
      "warm-switch": { median: 1, p95: 1, maximum: 1 },
    }, phases: [], background: [{ name: "branch", durationMs: 10 }] });
    expect(failures).toEqual([
      "full bootstrap p95 2300.0ms > 2000ms (median 2100.0ms, p95 2300.0ms, max 2300.0ms)",
    ]);
  });

  it("rejects serial extension binding during a Full Mode cold switch", () => {
    const failures = evaluateHostBudgets({ mode: "full", summaries: {
      bootstrap: { median: 100, p95: 100, maximum: 100 },
      "cold-switch": { median: 2_600, p95: 2_800, maximum: 2_800 },
      "warm-switch": { median: 1, p95: 1, maximum: 1 },
    }, phases: [{ scenario: "cold-switch", totalMs: 1_800, phases: [{ name: "bind", durationMs: 1_200 }] }], background: [{ name: "branch", durationMs: 10 }] });
    expect(failures).toEqual([
      "full cold-switch p95 2800.0ms > 2500ms (median 2600.0ms, p95 2800.0ms, max 2800.0ms)",
      "full cold-switch still uses serial extension binding (1200.0ms)",
    ]);
  });

  it("rejects branch resolution in the critical bootstrap path", () => {
    const failures = evaluateHostBudgets({ mode: "safe", summaries: {
      bootstrap: { median: 100, p95: 100, maximum: 100 },
      "warm-switch": { median: 1, p95: 1, maximum: 1 },
    }, phases: [{ scenario: "bootstrap", totalMs: 100, phases: [{ name: "branch", durationMs: 80 }] }], background: [] });
    expect(failures).toEqual([
      "bootstrap still waits 80.0ms for branch resolution",
      "background branch duration was not reported by the host fixture",
    ]);
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
      mountDurationsMs: { median: 998, p95: 999, maximum: 999 },
      longTasksMs: { maximum: 80 },
      commitDurationsMs: { p95: 30 },
      domNodes: 9_000,
    }] };
    const failures = evaluateRendererBudgets(report, {
      rendererFrameP95Ms: 24,
      rendererMountP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
    });
    expect(failures).toHaveLength(5);
  });

  it("keeps documented renderer budgets aligned with the release gate", async () => {
    const [budgetText, documentation] = await Promise.all([
      readFile(new URL("./performance-budgets.json", import.meta.url), "utf8"),
      readFile(new URL("../docs/PERFORMANCE.md", import.meta.url), "utf8"),
    ]);
    const budgets = JSON.parse(budgetText);
    expect(documentation).toContain(`${budgets.rendererFrameP95Ms} ms frame p95`);
    expect(documentation).toContain(`${budgets.rendererMountP95Ms} ms mount p95`);
    expect(documentation).toContain(`${budgets.rendererLongTaskMs} ms`);
    expect(budgets.rendererScenarioBudgets["long-user-message"]).toBeUndefined();
    expect(budgets.rendererScenarioBudgets["transcript-1000-turns"].mountP95Ms).toBe(40);
  });

  it("keeps the documented renderer table generated from the checked-in report", async () => {
    const [reportText, documentation] = await Promise.all([
      readFile(new URL("../reports/renderer-report.json", import.meta.url), "utf8"),
      readFile(new URL("../docs/PERFORMANCE.md", import.meta.url), "utf8"),
    ]);
    const report = JSON.parse(reportText);
    const labels = new Map([
      ["markdown-code-stream-150kb", "markdown code stream (150 KB)"],
      ["markdown-plain-stream-150kb", "markdown plain stream (150 KB)"],
      ["tool-output-1mb", "tool output (1 MB)"],
      ["transcript-1000-turns", "transcript (1,000 turns)"],
      ["diff-2mb", "diff (2 MB)"],
      ["thread-shells-10000", "thread shells (10,000)"],
      ["workspace-files-10000", "workspace files (10,000)"],
      ["picker-catalog-10000", "picker catalog (10,000)"],
      ["long-user-message", "long user message (12 KB)"],
    ]);
    const format = (value) => value.toFixed(1);
    const number = new Intl.NumberFormat("en-US");
    for (const scenario of report.scenarios) {
      const row = [
        labels.get(scenario.id),
        ["frameIntervalsMs", "mountDurationsMs", "updateDurationsMs", "longTasksMs"].map((metric) => {
          const values = scenario[metric];
          return `${format(values.median)} / ${format(values.p95)} / ${format(values.maximum)}`;
        }),
        number.format(scenario.domNodes),
      ];
      expect(documentation).toContain(`| ${row[0]} | ${row[1][0]} | ${row[1][1]} | ${row[1][2]} | ${row[1][3]} | ${row[2]} |`);
      for (const metric of ["frameIntervalsMs", "mountDurationsMs", "updateDurationsMs", "longTasksMs", "heapBytes"]) {
        expect(scenario[metric].p95).toBeLessThanOrEqual(scenario[metric].maximum);
      }
    }
  });

  it("supports explicit scenario budgets for one-time transcript mounting", () => {
    const report = { scenarios: [{
      id: "transcript-1000-turns",
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 17 },
      mountDurationsMs: { median: 22, p95: 32, maximum: 32 },
      longTasksMs: { maximum: 0 },
      commitDurationsMs: { median: 22, p95: 32, maximum: 32 },
      domNodes: 100,
    }] };
    expect(evaluateRendererBudgets(report, {
      rendererFrameP95Ms: 24,
      rendererMountP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererScenarioBudgets: { "transcript-1000-turns": { mountP95Ms: 40, commitP95Ms: 40 } },
    })).toEqual([]);
  });

  it("enforces the transcript mount budget independently from update work", () => {
    const failures = evaluateRendererBudgets({ scenarios: [{
      id: "transcript-1000-turns",
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 17 },
      mountDurationsMs: { median: 900, p95: 999, maximum: 999 },
      longTasksMs: { maximum: 0 },
      updateDurationsMs: { median: 1, p95: 2, maximum: 2 },
      domNodes: 100,
    }] }, {
      rendererFrameP95Ms: 24,
      rendererMountP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererScenarioBudgets: { "transcript-1000-turns": { mountP95Ms: 40, longTaskMs: 60 } },
    });
    expect(failures.some((failure) => failure.includes("mount p95 999.0ms > 40ms"))).toBe(true);
  });

  it("rejects missing renderer scenarios and measurements", () => {
    const failures = evaluateRendererBudgets({ scenarios: [{ id: "partial", longTaskObserverSupported: false, frameIntervalsMs: {}, longTasksMs: {}, commitDurationsMs: {} }] }, {
      rendererFrameP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererRequiredScenarios: ["required"],
    });
    expect(failures).toHaveLength(7);
  });
});
