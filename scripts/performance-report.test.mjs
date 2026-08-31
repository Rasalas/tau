import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAsset, evaluateBuildBudgets } from "./build-report.mjs";
import { evaluateStartBudgets } from "./start-report.mjs";
import { evaluateRendererBudgets } from "./renderer-budget.mjs";
import { evaluateHostBudgets } from "./host-budget.mjs";
import { evaluateGitBudgets } from "./git-budget.mjs";
import { buildRendererComparisonReproduction } from "./renderer-comparison-commands.mjs";

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

  it("supports explicit scenario budgets for one-time transcript mounting", () => {
    const report = { scenarios: [{
      id: "transcript-1000-turns",
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 17 },
      longTasksMs: { maximum: 0 },
      commitDurationsMs: { median: 22, p95: 32, maximum: 32 },
      domNodes: 100,
    }] };
    expect(evaluateRendererBudgets(report, {
      rendererFrameP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererScenarioBudgets: { "transcript-1000-turns": { commitP95Ms: 40 } },
    })).toEqual([]);
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

  it("parses a dry-run renderer comparison recipe with all explicit inputs", () => {
    const subjectRoot = "/tmp/tau renderer subject";
    const currentRoot = "/tmp/tau renderer measured";
    const reproduction = buildRendererComparisonReproduction({
      currentRoot,
      subjectRoot,
      baselineCommit: "baseline-commit",
      currentCommit: "subject-commit",
      baselinePatch: `${subjectRoot}/reports/renderer-transcript-legacy-baseline.patch`,
    });
    const aggregateCommand = reproduction.aggregation.command;
    expect((aggregateCommand.match(/--baseline /gu) ?? [])).toHaveLength(3);
    expect((aggregateCommand.match(/--current /gu) ?? [])).toHaveLength(3);
    expect(aggregateCommand).toContain('--baseline-root "$BASELINE_ROOT"');
    expect(aggregateCommand).toContain('--current-root "$CURRENT_ROOT"');
    expect(aggregateCommand).toContain('--baseline-commit "$BASELINE_COMMIT"');
    expect(aggregateCommand).toContain('--current-commit "$CURRENT_COMMIT"');
    expect(aggregateCommand).toContain('--baseline-patch "$BASELINE_PATCH"');
    expect(aggregateCommand).toContain('--baseline "$SUBJECT_ROOT/reports/renderer-transcript-baseline-run-01.json"');
    expect(aggregateCommand).toContain('--current "$SUBJECT_ROOT/reports/renderer-transcript-current-run-03.json"');
    expect(aggregateCommand).not.toContain("...");
    expect(reproduction.subject.currentCommit).toBe("subject-commit");
    expect(reproduction.subject.currentRoot).toBe(subjectRoot);
    expect(reproduction.subject.measuredCurrentRoot).toBe("$CURRENT_ROOT");
    expect(reproduction.current.worktreeVariable).toBe("$CURRENT_ROOT");
    expect(reproduction.shell).toContain('git -C "$SUBJECT_ROOT" worktree add --detach "$CURRENT_ROOT" "$CURRENT_COMMIT"');
    expect(reproduction.shell).toContain('git -C "$BASELINE_ROOT" apply "$BASELINE_PATCH"');
    expect(reproduction.shell).toContain('npm --prefix "$CURRENT_ROOT" run build');
    expect(reproduction.shell).not.toContain('npm --prefix "$SUBJECT_ROOT" run build');
    execFileSync("/bin/sh", ["-n"], { input: reproduction.shell, encoding: "utf8" });

    const dryRun = JSON.parse(execFileSync(process.execPath, [
      "scripts/renderer-comparison-aggregate.mjs",
      "--dry-run",
      "--current-root",
      currentRoot,
      "--subject-root",
      subjectRoot,
      "--baseline-commit",
      "baseline-commit",
      "--current-commit",
      "subject-commit",
      "--baseline-patch",
      `${subjectRoot}/reports/renderer-transcript-legacy-baseline.patch`,
    ], { encoding: "utf8" }));
    expect(dryRun.aggregation.command).toBe(aggregateCommand);
    expect(dryRun.baseline.commands).toContain('git -C "$SUBJECT_ROOT" worktree add --detach "$BASELINE_ROOT" "$BASELINE_COMMIT"');
  });

  it("hashes artifacts from the pinned detached current root", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "tau-renderer-aggregate-"));
    const subjectRoot = join(fixtureRoot, "subject");
    const baselineRoot = join(fixtureRoot, "baseline");
    const currentRoot = join(fixtureRoot, "current");
    const reports = [
      "renderer-transcript-baseline-run-01.json",
      "renderer-transcript-baseline-run-02.json",
      "renderer-transcript-baseline-run-03.json",
      "renderer-transcript-current-run-01.json",
      "renderer-transcript-current-run-02.json",
      "renderer-transcript-current-run-03.json",
    ];
    try {
      await Promise.all([
        mkdir(join(subjectRoot, "reports"), { recursive: true }),
        mkdir(join(subjectRoot, "dist"), { recursive: true }),
        mkdir(join(baselineRoot, "dist"), { recursive: true }),
        mkdir(join(currentRoot, "dist"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(subjectRoot, "dist", "artifact.js"), "subject artifact"),
        writeFile(join(baselineRoot, "dist", "artifact.js"), "baseline artifact"),
        writeFile(join(currentRoot, "dist", "artifact.js"), "current artifact"),
        writeFile(join(subjectRoot, "reports", "renderer-transcript-legacy-baseline.patch"), ""),
        ...reports.map(async (name) => writeFile(
          join(subjectRoot, "reports", name),
          await readFile(new URL(`../reports/${name}`, import.meta.url)),
        )),
      ]);

      for (const root of [baselineRoot, currentRoot]) {
        execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
        execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
        execFileSync("git", [
          "-C", root,
          "-c", "user.name=Renderer Test",
          "-c", "user.email=renderer-test@example.invalid",
          "commit", "--quiet", "-m", "fixture",
        ], { stdio: "ignore" });
      }
      const gitHead = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const baselineCommit = gitHead(baselineRoot);
      const currentCommit = gitHead(currentRoot);
      execFileSync("git", ["-C", baselineRoot, "checkout", "--quiet", "--detach", "HEAD"], { stdio: "ignore" });

      const aggregateArgs = [
        fileURLToPath(new URL("./renderer-comparison-aggregate.mjs", import.meta.url)),
        ...reports.slice(0, 3).flatMap((name) => ["--baseline", join(subjectRoot, "reports", name)]),
        ...reports.slice(3).flatMap((name) => ["--current", join(subjectRoot, "reports", name)]),
        "--baseline-root", baselineRoot,
        "--current-root", currentRoot,
        "--baseline-commit", baselineCommit,
        "--current-commit", currentCommit,
        "--baseline-patch", join(subjectRoot, "reports", "renderer-transcript-legacy-baseline.patch"),
        "--output", join(subjectRoot, "reports", "aggregate.json"),
        "--subject-root", subjectRoot,
      ];
      let detachedFailure;
      try {
        execFileSync(process.execPath, aggregateArgs, { encoding: "utf8" });
      } catch (error) {
        detachedFailure = error;
      }
      expect(`${detachedFailure?.message ?? ""}${detachedFailure?.stderr ?? ""}`).toMatch(/must be detached/u);

      execFileSync("git", ["-C", currentRoot, "checkout", "--quiet", "--detach", "HEAD"], { stdio: "ignore" });
      execFileSync(process.execPath, aggregateArgs, { encoding: "utf8" });
      const aggregate = JSON.parse(await readFile(join(subjectRoot, "reports", "aggregate.json"), "utf8"));
      const expectedCurrentHash = createHash("sha256").update("dist/artifact.js\0current artifact\0").digest("hex");
      const baselineHash = createHash("sha256").update("dist/artifact.js\0baseline artifact\0").digest("hex");
      expect(aggregate.current.buildArtifactSha256).toBe(expectedCurrentHash);
      expect(aggregate.current.buildArtifactSha256).not.toBe(baselineHash);
      expect(aggregate.reproduction.current.measuredRoot).toBe("$CURRENT_ROOT");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
