import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkspaceRef } from "tau/host-extension";
import { repositoryFolderName, type CloneSnapshot, type CloneStage } from "./protocol.js";

export { repositoryFolderName };

const STAGES: ReadonlyArray<readonly [RegExp, CloneStage]> = [
  [/^remote: (?:Enumerating|Counting|Compressing) objects/u, "counting"],
  [/^Receiving objects/u, "receiving"],
  [/^Resolving deltas/u, "resolving"],
  [/^(?:Updating|Checking out) files/u, "checkout"],
];
const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*$/u;

/** One line of `git clone --progress`; git redraws a counter with `\r`, so each redraw is a line. */
export function parseCloneProgress(line: string): { stage: CloneStage; percent?: number; detail?: string } | undefined {
  const text = line.trim();
  const stage = STAGES.find(([pattern]) => pattern.test(text))?.[1];
  if (!stage) return undefined;
  const match = PERCENT.exec(text);
  if (!match) return { stage };
  const detail = match[4]?.replace(/,?\s*done\.?$/u, "").trim();
  return { stage, percent: Math.min(100, Math.max(0, Number(match[1]))), ...(detail ? { detail } : {}) };
}

export type CloneSpawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CloneJobsOptions {
  git: string;
  emit(snapshot: CloneSnapshot): void;
  identify(path: string): WorkspaceRef;
  spawn?: CloneSpawner;
  onSubprocess?(): void;
  /** How long a cancelled git gets to exit before it is killed. */
  killAfterMs?: number;
}

interface Job {
  snapshot: CloneSnapshot;
  child: ChildProcess;
  parent: string;
  cancelled: boolean;
  tail: string[];
}

/**
 * Clones as jobs the client follows by pushes: progress by stage and percent,
 * cancel at any point. A clone only ever writes into a destination that did
 * not exist when it started, and a failed or cancelled one removes that folder
 * again — only when what is left there is git's own.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly settled = new WeakSet<Job>();

  constructor(private readonly options: CloneJobsOptions) {}

  list(): CloneSnapshot[] {
    return [...this.jobs.values()].map((job) => ({ ...job.snapshot }));
  }

  async start(source: string, parent: string): Promise<CloneSnapshot> {
    if (!isAbsolute(parent) || !(await stat(parent).then((entry) => entry.isDirectory(), () => false))) {
      throw new Error("Choose an existing parent folder for the clone.");
    }
    const name = repositoryFolderName(source);
    const destination = join(parent, name);
    if (await lstat(destination).then(() => true, () => false)) {
      throw new Error(`${destination} already exists. Choose another folder, or remove it first.`);
    }
    const snapshot: CloneSnapshot = { id: randomUUID(), name, destination, phase: "running", stage: "connecting" };
    this.options.onSubprocess?.();
    const child = (this.options.spawn ?? spawnProcess)(this.options.git, ["clone", "--progress", "--", source, destination], {
      cwd: parent,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // No terminal can answer a credential prompt; git fails instead of waiting.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const job: Job = { snapshot, child, parent, cancelled: false, tail: [] };
    this.jobs.set(snapshot.id, job);
    this.follow(job);
    this.emit(job);
    return { ...snapshot };
  }

  /** False when no such clone is running. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.snapshot.phase !== "running") return false;
    job.cancelled = true;
    job.child.kill("SIGTERM");
    const kill = setTimeout(() => { if (job.child.exitCode === null) job.child.kill("SIGKILL"); }, this.options.killAfterMs ?? 5_000);
    job.child.once("close", () => clearTimeout(kill));
    return true;
  }

  /** Settled clones stay listed until the client forgets them. */
  forget(id: string): void {
    if (this.jobs.get(id)?.snapshot.phase !== "running") this.jobs.delete(id);
  }

  dispose(): void {
    for (const job of this.jobs.values()) if (job.snapshot.phase === "running") this.cancel(job.snapshot.id);
  }

  private follow(job: Job): void {
    let pending = "";
    job.child.stderr?.setEncoding("utf8");
    job.child.stderr?.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r\n|\r|\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) this.line(job, line);
    });
    job.child.once("error", (error) => this.settle(job, null, error.message));
    job.child.once("close", (code) => {
      if (pending) this.line(job, pending);
      void this.settle(job, code);
    });
  }

  private line(job: Job, line: string): void {
    const progress = parseCloneProgress(line);
    if (!progress) {
      const text = line.trim();
      if (!text || text.startsWith("Cloning into")) return;
      job.tail.push(text);
      if (job.tail.length > 4) job.tail.shift();
      return;
    }
    const { snapshot } = job;
    if (snapshot.stage === progress.stage && snapshot.percent === progress.percent) return;
    job.snapshot = {
      ...snapshot,
      stage: progress.stage,
      ...(progress.percent === undefined ? {} : { percent: progress.percent }),
      ...(progress.detail ? { detail: progress.detail } : {}),
    };
    if (progress.percent === undefined) delete job.snapshot.percent;
    if (!progress.detail) delete job.snapshot.detail;
    this.emit(job);
  }

  private async settle(job: Job, code: number | null, spawnError?: string): Promise<void> {
    if (this.settled.has(job)) return;
    this.settled.add(job);
    if (code === 0 && !job.cancelled) {
      job.snapshot = { ...job.snapshot, phase: "done", stage: "checkout", percent: 100, workspace: this.options.identify(job.snapshot.destination) };
      delete job.snapshot.detail;
      this.emit(job);
      return;
    }
    const left = await this.removeLeftovers(job);
    const error = job.cancelled ? undefined : spawnError ?? (job.tail.join(" ") || `git clone exited with ${code ?? "a signal"}.`);
    job.snapshot = {
      ...job.snapshot,
      phase: job.cancelled ? "cancelled" : "failed",
      ...(error ? { error } : {}),
      ...(left ? { leftover: left } : {}),
    };
    this.emit(job);
  }

  /** Removes the destination this clone created; anything else that is there now stays. */
  private async removeLeftovers(job: Job): Promise<string | undefined> {
    const destination = job.snapshot.destination;
    if (resolve(dirname(destination)) !== resolve(job.parent) || basename(destination) !== job.snapshot.name) return destination;
    const entries = await readdir(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : null);
    if (entries === undefined) return undefined;
    // Only what git left behind may go: an empty folder or one with its `.git`.
    if (entries === null || (entries.length > 0 && !entries.includes(".git"))) return destination;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(destination, { recursive: true, force: true });
        return undefined;
      } catch {
        // A killed git may still be closing files.
        await new Promise((done) => setTimeout(done, 200));
      }
    }
    return destination;
  }

  private emit(job: Job): void {
    this.options.emit({ ...job.snapshot });
  }
}
