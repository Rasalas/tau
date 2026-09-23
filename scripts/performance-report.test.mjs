import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyAsset, evaluateBuildBudgets } from "./build-report.mjs";
import { buildFixtureEnv, evaluateStartBudgets } from "./start-report.mjs";
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

  it("drops ELECTRON_RUN_AS_NODE from the start fixture's env so Electron stays Electron", () => {
    const env = buildFixtureEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_IS_DEV).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
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
      "full bootstrap cold 2300.0ms > 2000ms (median 2100.0ms, p95 2300.0ms, max 2300.0ms)",
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

  it("fails a metadata command whose latency grows with the thread", () => {
    const lean = { median: 0.2, p95: 0.5, maximum: 0.6 };
    const base = { schemaVersion: 2, mode: "safe", summaries: {
      bootstrap: { median: 100, p95: 100, maximum: 100 },
      "warm-switch": { median: 1, p95: 1, maximum: 1 },
    }, phases: [], background: [{ name: "project-label", durationMs: 10 }] };
    const metadata = (long, entries = 20_000) => ({ entries: { short: 8, long: entries }, summaries: {
      "set-model-short": lean, "set-thinking-short": lean, "set-model-long": long, "set-thinking-long": lean,
    } });
    expect(evaluateHostBudgets({ ...base, metadata: metadata(lean) })).toEqual([]);
    expect(evaluateHostBudgets({ ...base, metadata: metadata({ median: 72, p95: 109, maximum: 120 }) })).toEqual([
      "set-model-long p95 109.0ms > 10ms (median 72.0ms)",
    ]);
    expect(evaluateHostBudgets({ ...base, metadata: metadata(lean, 800) })).toEqual([
      "metadata long thread has 800 entries < 10000",
    ]);
    expect(evaluateHostBudgets(base)).toEqual(["metadata commands were not measured by the host fixture"]);
  });

  it("fails a large thread that opens slowly or sends more than a page", () => {
    const lean = { median: 0.2, p95: 0.5, maximum: 0.6 };
    const fast = { median: 400, p95: 600, maximum: 700 };
    const base = { schemaVersion: 3, mode: "full", summaries: {
      bootstrap: { median: 100, p95: 100, maximum: 100 },
      "cold-switch": { median: 100, p95: 100, maximum: 100 },
      "warm-switch": { median: 1, p95: 1, maximum: 1 },
    }, phases: [], background: [{ name: "project-label", durationMs: 10 }], metadata: { entries: { short: 8, long: 20_000 }, summaries: {
      "set-model-short": lean, "set-thinking-short": lean, "set-model-long": lean, "set-thinking-long": lean,
    } } };
    const large = (open, pageMessages = 20) => ({ entries: 20_000, pageMessages, summaries: { open, bootstrap: fast, "full-ready": fast } });
    expect(evaluateHostBudgets({ ...base, largeThread: large(fast) })).toEqual([]);
    expect(evaluateHostBudgets({ ...base, largeThread: large({ median: 43_000, p95: 54_000, maximum: 54_000 }) })).toEqual([
      "large-thread open p95 54000.0ms > 2500ms (median 43000.0ms)",
    ]);
    expect(evaluateHostBudgets({ ...base, largeThread: large(fast, 40_000) })).toEqual([
      "large thread first page holds 40000 messages > 60",
    ]);
    expect(evaluateHostBudgets(base)).toEqual(["the large thread was not measured by the Full Mode host fixture"]);
    expect(evaluateHostBudgets({ ...base, mode: "safe" })).toEqual([]);
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

  it("fails a stream end that reparses the whole message in one commit", () => {
    const scenario = {
      id: "markdown-fenced-stream-150kb",
      fixture: { streamEnd: true },
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 17 },
      mountDurationsMs: { p95: 2 },
      longTasksMs: { maximum: 0 },
      updateDurationsMs: { p95: 8 },
      domNodes: 4_556,
    };
    const budgets = { rendererStreamEndCommitMs: 16 };
    expect(evaluateRendererBudgets({ scenarios: [scenario] }, budgets)).toEqual(["markdown-fenced-stream-150kb stream end commit p95 was not reported by the renderer fixture"]);
    const slow = { ...scenario, streamEndCommitMs: { median: 48.3, p95: 62.4, maximum: 69.6 } };
    expect(evaluateRendererBudgets({ scenarios: [slow] }, budgets)).toEqual(["markdown-fenced-stream-150kb stream end commit p95 62.4ms > 16ms (median 48.3ms, p95 62.4ms, max 69.6ms)"]);
    expect(evaluateRendererBudgets({ scenarios: [{ ...scenario, streamEndCommitMs: { median: 2.3, p95: 3, maximum: 3.1 } }] }, budgets)).toEqual([]);
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
    expect(budgets.rendererScenarioBudgets["transcript-1000-turns"].commitP95Ms).toBeUndefined();
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

  it("keeps transcript updates on the strict global 24 ms budget", () => {
    const failures = evaluateRendererBudgets({ scenarios: [{
      id: "transcript-1000-turns",
      longTaskObserverSupported: true,
      frameIntervalsMs: { p95: 17 },
      mountDurationsMs: { p95: 38 },
      longTasksMs: { maximum: 0 },
      updateDurationsMs: { median: 25, p95: 32, maximum: 32 },
      domNodes: 100,
    }] }, {
      rendererFrameP95Ms: 24,
      rendererMountP95Ms: 24,
      rendererLongTaskMs: 50,
      rendererCommitP95Ms: 24,
      rendererDomNodes: 5_000,
      rendererScenarioBudgets: { "transcript-1000-turns": { mountP95Ms: 40, longTaskMs: 60 } },
    });
    expect(failures.some((failure) => failure.includes("commit p95 32.0ms > 24ms"))).toBe(true);
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

  // Three git repositories and two aggregate runs; slow when the whole suite loads the machine.
  it("hashes artifacts from the pinned detached current root", { timeout: 60_000 }, async () => {
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
