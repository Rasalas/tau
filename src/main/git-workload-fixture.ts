import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { GitCoordinator } from "./git-coordinator.js";

const execFileAsync = promisify(execFile);

export interface GitWorkloadFixture {
  cwd: string;
  cleanup(): Promise<void>;
}

export interface GitWorkloadReport {
  files: number;
  baselineSubprocesses: number;
  coordinatedSubprocesses: number;
  elapsedMs: number;
  maxParallelSubprocesses: number;
  bytesRead: number;
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

/** Measures one bundled project scan and reports the old fan-out as a baseline. */
export async function measureGitWorkload(cwd: string): Promise<GitWorkloadReport> {
  const coordinator = new GitCoordinator({ maxConcurrency: 4 });
  const startedAt = performance.now();
  const [changes, workspace, branch] = await Promise.all([
    coordinator.getChanges(cwd),
    coordinator.getWorkspaceInfo(cwd),
    coordinator.getBranch(cwd),
  ]);
  const metrics = coordinator.metrics();
  return {
    files: changes.files.length,
    // Changes (3), workspace (5), and branch (1) were separate reads.
    baselineSubprocesses: 9,
    coordinatedSubprocesses: metrics.subprocesses,
    elapsedMs: performance.now() - startedAt,
    maxParallelSubprocesses: metrics.maxParallelSubprocesses,
    bytesRead: metrics.bytesRead,
  };
}
