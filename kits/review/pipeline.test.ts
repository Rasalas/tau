import { describe, expect, it } from "vitest";
import { usualDurations } from "./github-pipeline.js";
import { checksPipelines, formatDuration, jobFor, jobProgress, jobTiming, median, pipelinesProgress, runIdOf, runsPipeline, stageLevels, workflowJobs } from "./pipeline.js";
import type { PullRequestCheck } from "./protocol.js";

const WORKFLOW = `
name: CI
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint # needs: nothing
  "unit":
    name: Unit tests
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
  build:
    needs: [lint, unit]
    name: 'Build #\${{ github.run_number }}'
    steps:
      - name: not the job's name
        run: make
  e2e:
    needs:
      - build
    runs-on: ubuntu-latest
  deploy:
    needs: e2e   # a comment
    uses: ./.github/workflows/deploy.yml
`;

const RUN = "https://github.com/acme/demo/actions/runs/42/job/";
const check = (name: string, status: PullRequestCheck["status"], extra: Partial<PullRequestCheck> = {}): PullRequestCheck =>
  ({ name, status, workflow: "CI", url: `${RUN}${name.length}`, ...extra });

describe("workflow files", () => {
  it("reads job ids, names and needs in every shape they are written", () => {
    expect(workflowJobs(WORKFLOW)).toEqual([
      { id: "lint", needs: [] },
      { id: "unit", name: "Unit tests", needs: [] },
      { id: "build", name: "Build #${{ github.run_number }}", needs: ["lint", "unit"] },
      { id: "e2e", needs: ["build"] },
      { id: "deploy", needs: ["e2e"] },
    ]);
  });

  it("ignores keys outside jobs and a file without any", () => {
    expect(workflowJobs("name: x\non:\n  push:\n    branches: [main]\n")).toEqual([]);
  });

  it("puts each job one stage after the latest it needs, and survives a cycle", () => {
    const levels = stageLevels(workflowJobs(WORKFLOW));
    expect(Object.fromEntries(levels)).toEqual({ lint: 0, unit: 0, build: 1, e2e: 2, deploy: 3 });
    const cycle = stageLevels([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }, { id: "c", needs: ["missing"] }]);
    expect(cycle.get("c")).toBe(0);
    expect([...cycle.values()].every(Number.isFinite)).toBe(true);
  });

  it("finds a check's job by name, matrix suffix, called workflow and template", () => {
    const jobs = workflowJobs(WORKFLOW);
    expect(jobFor("lint", jobs)?.id).toBe("lint");
    expect(jobFor("Unit tests (macos-latest)", jobs)?.id).toBe("unit");
    expect(jobFor("Build #318", jobs)?.id).toBe("build");
    expect(jobFor("deploy / release", jobs)?.id).toBe("deploy");
    expect(jobFor("Vercel", jobs)).toBeUndefined();
  });
});

describe("stages", () => {
  it("groups a workflow's checks into stages by needs", () => {
    const facts = { 42: { jobs: workflowJobs(WORKFLOW), expected: { lint: 60_000 } } };
    const [pipeline] = checksPipelines([
      check("Build #7", "pending", { queued: true }),
      check("lint", "passed"),
      check("Unit tests (ubuntu-latest)", "passed"),
      check("Unit tests (macos-latest)", "pending", { startedAt: "2026-10-01T10:00:00Z" }),
      check("e2e", "pending", { queued: true }),
    ], facts);
    expect(pipeline!.name).toBe("CI");
    expect(pipeline!.stages.map((stage) => stage.map((job) => `${job.name}:${job.state}`))).toEqual([
      ["lint:passed", "Unit tests (ubuntu-latest):passed", "Unit tests (macos-latest):running"],
      ["Build #7:queued"],
      ["e2e:queued"],
    ]);
    expect(pipeline!.stages[0]![0]!.expectedMs).toBe(60_000);
    expect(pipeline!.stages[0]![2]!.startedAt).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("puts a workflow without its file in one stage, other checks last, and strips the workflow prefix", () => {
    const pipelines = checksPipelines([
      { name: "Vercel", status: "passed" },
      check("Release / test", "failed", { workflow: "Release" }),
      check("CI / test", "passed"),
      check("ignored-year-one", "pending", { startedAt: "0001-01-01T00:00:00Z" }),
    ]);
    expect(pipelines.map((pipeline) => [pipeline.name, pipeline.stages.length])).toEqual([["Release", 1], ["CI", 1], ["Other checks", 1]]);
    expect(pipelines[0]!.stages[0]![0]!.name).toBe("test");
    expect(pipelines[1]!.stages[0]![1]!.startedAt).toBeUndefined();
  });

  it("reads the run id from a job link", () => {
    expect(runIdOf("https://github.com/a/b/actions/runs/123/job/9")).toBe("123");
    expect(runIdOf("https://vercel.com/a/b")).toBeUndefined();
  });

  it("makes a worktree's script runs one stage", () => {
    const pipeline = runsPipeline([{ name: "test", status: "running", at: 5, expectedMs: 10 }, { name: "lint", status: "stopped", at: 1, endedAt: 3 }]);
    expect(pipeline.stages).toEqual([[{ name: "test", state: "running", startedAt: 5, expectedMs: 10 }, { name: "lint", state: "cancelled", startedAt: 1, endedAt: 3 }]]);
  });
});

describe("expected duration", () => {
  it("is the median of the successful runs of the same job", () => {
    const run = (took: Record<string, [number, string]>) => ({
      jobs: Object.entries(took).map(([name, [seconds, conclusion]]) => ({ name, conclusion, started_at: "2026-10-01T10:00:00Z", completed_at: new Date(Date.parse("2026-10-01T10:00:00Z") + seconds * 1000).toISOString() })),
    });
    expect(usualDurations([
      run({ lint: [60, "success"], test: [300, "success"] }),
      run({ lint: [90, "success"], test: [900, "failure"] }),
      run({ lint: [30, "success"], test: [200, "success"] }),
      run({ lint: [45, "success"] }),
    ])).toEqual({ lint: 52_500, test: 250_000 });
    expect(usualDurations([{ jobs: [{ name: "x", conclusion: "success", started_at: "bad" }] }, {}])).toEqual({});
  });

  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([])).toBeUndefined();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
  });
});

describe("progress", () => {
  const running = { name: "test", state: "running" as const, startedAt: 1_000, expectedMs: 4_000 };

  it("fills with elapsed time over the usual time, never past full", () => {
    expect(jobProgress(running, 2_000)).toBe(0.25);
    expect(jobProgress(running, 9_000)).toBe(1);
    expect(jobProgress({ ...running, expectedMs: undefined }, 2_000)).toBeUndefined();
    expect(jobProgress({ name: "x", state: "queued" }, 2_000)).toBe(0);
    expect(jobProgress({ name: "x", state: "failed" }, 2_000)).toBe(1);
  });

  it("sums every job of every pipeline for the chip", () => {
    const pipelines = [{ name: "CI", stages: [[{ name: "a", state: "passed" as const }, running], [{ name: "c", state: "queued" as const }, { ...running, name: "d", expectedMs: undefined }]] }];
    expect(pipelinesProgress(pipelines, 3_000)).toEqual({ fraction: 1.5 / 4, done: 1, total: 4 });
    expect(pipelinesProgress([], 0)).toEqual({ fraction: 0, done: 0, total: 0 });
  });

  it("says elapsed and expected in words", () => {
    expect(formatDuration(45_400)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
    expect(jobTiming(running, 2_000)).toBe("Running · 1s of about 4s");
    expect(jobTiming(running, 9_000)).toBe("Running · 8s of about 4s, longer than usual");
    expect(jobTiming({ ...running, expectedMs: undefined }, 61_000)).toBe("Running · 1m 0s, no usual time yet");
    expect(jobTiming({ name: "x", state: "passed", startedAt: 1_000, endedAt: 126_000 }, 0)).toBe("Passed · 2m 5s");
    expect(jobTiming({ name: "x", state: "queued", expectedMs: 60_000 }, 0)).toBe("Queued · usually 1m 0s");
  });
});
