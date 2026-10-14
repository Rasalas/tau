import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSummary, summarizeReports } from "./summary.mjs";

const source = (results, overrides = {}) => ({ file: "compare-test.json", report: {
  schemaVersion: 1, generatedAt: "2026-10-14T12:00:00.000Z",
  machine: { chip: "Test chip", platform: "darwin", architecture: "arm64", memoryGiB: 16, logicalCores: 10 },
  apps: { tau: { app: "Tau", commit: "abc123", electron: "44" }, reference: { app: "T3 Code", commit: "def456", electron: "44" } },
  window: { width: 1440, height: 900 }, fixture: [{ turns: 100 }], turn: { durationMs: 14400 },
  options: { runs: 2, warmup: 1, idleMs: 5000 }, results, ...overrides,
} });
const run = (ms) => ({ loadAtStart: 2, startup: { interactiveMs: ms }, replay: { endVisibleMs: ms + 14400, streamFrames: { p95: 17, frames: 800 }, streamLongTasks: { count: 2, totalMs: 110 }, wire: { receivedKiB: 100, httpKiB: 10 } }, idleCpu: { complete: true, windowMs: 5000, totalPercent: 3, byRolePercent: { backend: 1, renderer: 2 } } });

describe("comparison summaries", () => {
  it("pools raw runs and raw warm switches across normal and switch-only reports", () => {
    const switched = { switchLoadAtStart: 3, switches: [1, 2, 20].map((ms, index) => ({ kind: "codex", size: "short", round: index, result: { visibleMs: ms } })) };
    const summary = summarizeReports([source({ tau: [run(100), run(300)], reference: [run(200)] }), source({ tau: [switched], reference: [switched] }, { options: { threadSwitch: true, idleMs: 5000, warmup: 2 } })]);
    expect(summary.metrics.tau["startup.interactiveMs"]).toEqual({ n: 2, median: 200, min: 100, max: 300 });
    expect(summary.metrics.reference["startup.interactiveMs"].median).toBe(200);
    expect(summary.metrics.tau["threadSwitch.codex.short.cold.visibleMs"].median).toBe(1);
    expect(summary.metrics.tau["threadSwitch.codex.short.warm.visibleMs"]).toEqual({ n: 2, median: 11, min: 2, max: 20 });
    expect(summary.metrics.tau["idleCpu.byRolePercent.backend"].median).toBe(1);
    const markdown = renderSummary(summary);
    expect(markdown).toContain("Tau | T3 Code");
    expect(markdown).toContain("200 [100, 300]; n=2");
    expect(markdown).toContain("abc123");
    expect(markdown).toContain("Test chip");
  });

  it("does not treat missing or incomplete CPU, null and non-finite readings as zero", () => {
    const summary = summarizeReports([source({ tau: [{ ...run(null), idleCpu: { complete: false, totalPercent: 0 } }], reference: [{}] })]);
    expect(summary.metrics.tau["startup.interactiveMs"]).toBeNull();
    expect(summary.metrics.tau["idleCpu.totalPercent"]).toBeNull();
    expect(summary.metrics.reference["replay.endVisibleMs"]).toBeNull();
    expect(renderSummary(summary)).toContain("not measured");
    expect(summary.warnings.join(" ")).toContain("incomplete CPU");
    expect(summarizeReports([source({ tau: [run(Infinity)], reference: [] })]).metrics.tau["startup.interactiveMs"]).toBeNull();
    const lowCpu = { ...run(100), idleCpu: { complete: true, totalPercent: 0.02 } };
    expect(summarizeReports([source({ tau: [lowCpu] })]).metrics.tau["idleCpu.totalPercent"].median).toBe(0.02);
  });

  it("rejects incompatible machines, commits, fixtures and unsupported report shapes", () => {
    const base = source({ tau: [run(100)], reference: [run(200)] });
    for (const overrides of [{ machine: { chip: "Other" } }, { fixture: [] }, { turn: { durationMs: 1 } }, { options: { idleMs: 1000 } }, { apps: { tau: { app: "Tau", commit: "changed" } } }]) {
      expect(() => summarizeReports([base, source(base.report.results, overrides)])).toThrow(/incompatible/u);
    }
    expect(() => summarizeReports([])).toThrow();
    expect(() => summarizeReports([source([], { app: { app: "Tau" }, apps: undefined })])).toThrow();
    expect(() => summarizeReports([source({}, { schemaVersion: 99 })])).toThrow();
  });

  it("writes a reviewable Markdown and JSON pair from the CLI without launching apps", () => {
    const dir = mkdtempSync(join(tmpdir(), "compare-summary-"));
    try {
      const input = join(dir, "compare.json");
      const output = join(dir, "docs", "compare-2026-10-14");
      writeFileSync(input, JSON.stringify(source({ tau: [run(100)], reference: [run(200)] }).report));
      execFileSync(process.execPath, ["scripts/compare/summary.mjs", "--out", output, input]);
      expect(JSON.parse(readFileSync(`${output}.json`, "utf8")).apps.reference.commit).toBe("def456");
      expect(readFileSync(`${output}.md`, "utf8")).toContain("spawn to rail + composer");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
