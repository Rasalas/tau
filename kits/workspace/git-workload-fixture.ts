import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { GitCoordinator } from "./git-coordinator.js";
import { readProjectGitState } from "./workspace-git.js";

const execFileAsync = promisify(execFile);

export interface GitWorkloadFixture {
  cwd: string;
  cleanup(): Promise<void>;
}

export interface GitWorkloadReport {
  files: number;
  baselineSubprocesses: number;
  baselineElapsedMs: number;
  coordinatedSubprocesses: number;
  elapsedMs: number;
  maxParallelSubprocesses: number;
  bytesRead: number;
  overlappingRefreshSubprocesses: number;
  slowCommandMs: number;
  slowCommandState: string;
  manyProjectBranchP95Ms: number;
  manyProjectMaxParallelSubprocesses: number;
}

/** Durable, deterministic workload used by the Git performance suite. */
export async function createGitWorkloadFixture(fileCount = 2_000): Promise<GitWorkloadFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "tau-git-workload-"));
  try {
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tau-fixture@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tau Git fixture"], { cwd });
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(cwd, `tracked-${String(index).padStart(5, "0")}.txt`), `line ${index}\n`),
    ));
    await execFileAsync("git", ["add", "-A"], { cwd });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd });
    await Promise.all([
      writeFile(join(cwd, "large-untracked.txt"), "x\n".repeat(300_000)),
      writeFile(join(cwd, "binary-untracked.bin"), Buffer.alloc(512_000, 0)),
      ...Array.from({ length: fileCount }, (_, index) =>
        writeFile(join(cwd, `tracked-${String(index).padStart(5, "0")}.txt`), `changed ${index}\n`),
      ),
    ]);
    return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

/** Measures baseline fan-out, deduplication, cancellation, and many-project bounds. */
export async function measureGitWorkload(cwd: string): Promise<GitWorkloadReport> {
  let baselineSubprocesses = 0;
  const baselineStartedAt = performance.now();
  await Promise.all(Array.from({ length: 3 }, () => readProjectGitState(cwd, {
    onGitCommand: () => { baselineSubprocesses += 1; },
  })));
  const baselineElapsedMs = performance.now() - baselineStartedAt;

  const coordinator = new GitCoordinator({ maxConcurrency: 4 });
  const startedAt = performance.now();
  const [changes] = await Promise.all([
    coordinator.getChanges(cwd),
    coordinator.getWorkspaceInfo(cwd),
    coordinator.getBranch(cwd),
  ]);
  const elapsedMs = performance.now() - startedAt;
  const initialMetrics = coordinator.metrics();

  coordinator.invalidate(cwd);
  await Promise.all(Array.from({ length: 12 }, (_, index) => index % 3 === 0
    ? coordinator.getChanges(cwd)
    : index % 3 === 1
      ? coordinator.getWorkspaceInfo(cwd)
      : coordinator.getBranch(cwd)));
  const overlapMetrics = coordinator.metrics();

  const slow = new GitCoordinator({
    maxConcurrency: 2,
    timeoutMs: 20,
    runGit: async (_project, _args, _maxBuffer, signal) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve("main\n"), 200);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    }),
  });
  const slowStartedAt = performance.now();
  await slow.getBranch("/slow-project");
  const slowCommandMs = performance.now() - slowStartedAt;

  let active = 0;
  let manyMaximum = 0;
  const many = new GitCoordinator({
    maxConcurrency: 4,
    runGit: async (project, args) => {
      active += 1;
      manyMaximum = Math.max(manyMaximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${project}\n`;
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "worktree") return `worktree ${project}\nbranch refs/heads/main\n`;
      return "";
    },
  });
  const manyDurations = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const projectStartedAt = performance.now();
    await many.getBranch(`/project-${index}`);
    return performance.now() - projectStartedAt;
  }));

  return {
    files: changes.files.length,
    baselineSubprocesses,
    baselineElapsedMs,
    coordinatedSubprocesses: initialMetrics.subprocesses,
    elapsedMs,
    maxParallelSubprocesses: initialMetrics.maxParallelSubprocesses,
    bytesRead: initialMetrics.bytesRead,
    overlappingRefreshSubprocesses: overlapMetrics.subprocesses - initialMetrics.subprocesses,
    slowCommandMs,
    slowCommandState: slow.getRefreshStatus("/slow-project").state,
    manyProjectBranchP95Ms: percentile(manyDurations, 0.95),
    manyProjectMaxParallelSubprocesses: manyMaximum,
  };
}
