import type { UiWorktreeStatus } from "tau/host-extension";
import {
  emptyProjectGitState,
  readProjectGitState,
  readWorktreeStatuses,
  runGitCommand,
  type GitRunner,
  type ProjectGitState,
  type UntrackedStatsOptions,
} from "./workspace-git.js";

export type GitRefreshKind = "status" | "branch" | "workspace";
export type GitRefreshState = "ready" | "refreshing" | "error";

export interface GitRefreshStatus {
  state: GitRefreshState;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface GitCoordinatorOptions {
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
  runGit?: GitRunner;
  untrackedStats?: UntrackedStatsOptions;
  onSubprocess?: () => void;
}

export interface GitCoordinatorMetrics {
  subprocesses: number;
  activeSubprocesses: number;
  maxParallelSubprocesses: number;
  bytesRead: number;
}

interface ProjectRecord {
  generation: number;
  cached?: { state: ProjectGitState; expiresAt: number };
  inFlight?: { generation: number; promise: Promise<ProjectGitState>; controller: AbortController };
  lastValid?: ProjectGitState;
  invalidated: Set<GitRefreshKind>;
  status: GitRefreshStatus;
  /** The last write queued for this project; the next one waits for it. */
  writing?: Promise<unknown>;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        let waiter: () => void;
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          reject(abortError());
        };
        waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }
    if (signal.aborted) throw abortError();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function abortError(): Error {
  return new Error("Git refresh cancelled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project-scoped Git read coordinator. All status, branch, and workspace reads
 * share one versioned scan, while callers receive independent cancellation.
 */
export class GitCoordinator {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly semaphore: Semaphore;
  private readonly runGit: GitRunner;
  private readonly untrackedStats?: UntrackedStatsOptions;
  private readonly onSubprocess?: () => void;
  private metricsValue: GitCoordinatorMetrics = {
    subprocesses: 0,
    activeSubprocesses: 0,
    maxParallelSubprocesses: 0,
    bytesRead: 0,
  };

  constructor(options: GitCoordinatorOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4);
    this.runGit = options.runGit ?? runGitCommand;
    this.untrackedStats = options.untrackedStats;
    this.onSubprocess = options.onSubprocess;
  }

  /** Reads the shared project state. Equal requests share the same promise. */
  async getState(cwd: string, signal?: AbortSignal, kind: GitRefreshKind = "status"): Promise<ProjectGitState> {
    const record = this.record(cwd);
    const now = Date.now();
    if (record.cached && record.cached.expiresAt > now && !record.invalidated.has(kind) && !record.inFlight) {
      return this.cancelForCaller(Promise.resolve(record.cached.state), signal);
    }
    if (!record.inFlight) {
      const generation = record.generation;
      const controller = new AbortController();
      const startedAt = Date.now();
      record.status = { state: "refreshing", startedAt };
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref?.();
      const run = async (): Promise<ProjectGitState> => {
        try {
          const state = await readProjectGitState(cwd, {
            runGit: (path, args, maxBuffer, scanSignal) => this.runCoordinated(
              path,
              args,
              maxBuffer,
              scanSignal ?? controller.signal,
            ),
            signal: controller.signal,
            throwOnError: true,
            untrackedStats: {
              ...this.untrackedStats,
              signal: controller.signal,
              onBytesRead: (bytes) => {
                this.metricsValue.bytesRead += bytes;
                this.untrackedStats?.onBytesRead?.(bytes);
              },
            },
          });
          if (record.generation === generation) {
            record.cached = { state, expiresAt: Date.now() + this.cacheTtlMs };
            record.lastValid = state;
            record.invalidated.clear();
            record.status = { state: "ready", finishedAt: Date.now() };
          }
          return state;
        } catch (error) {
          if (record.generation === generation) {
            record.status = { state: "error", message: errorMessage(error), finishedAt: Date.now() };
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          if (record.inFlight?.generation === generation) record.inFlight = undefined;
        }
      };
      record.inFlight = { generation, promise: run(), controller };
    }
    const promise = record.inFlight.promise.catch(() => {
      // A failed refresh must not erase a previously useful project view.
      if (record.lastValid) return record.lastValid;
      return emptyProjectGitState(cwd);
    });
    return this.cancelForCaller(promise, signal);
  }

  async getChanges(cwd: string, signal?: AbortSignal) {
    const state = await this.getState(cwd, signal, "status");
    return { ...state.changes, refreshStatus: this.getRefreshStatus(cwd) };
  }

  async getWorkspaceInfo(cwd: string, signal?: AbortSignal) {
    const state = await this.getState(cwd, signal, "workspace");
    return { ...state.workspace, refreshStatus: this.getRefreshStatus(cwd) };
  }

  async getWorktreeStatuses(cwd: string, threadCwds: readonly string[], signal?: AbortSignal): Promise<UiWorktreeStatus[]> {
    const state = await this.getState(cwd, signal, "workspace");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await readWorktreeStatuses(
        state.workspace.worktrees,
        state.workspace.refs,
        threadCwds,
        (path, args, maxBuffer, scanSignal) => this.runCoordinated(path, args, maxBuffer, scanSignal ?? controller.signal),
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async getBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    return (await this.getState(cwd, signal, "branch")).branch;
  }

  getRefreshStatus(cwd: string): GitRefreshStatus {
    return this.record(cwd).status;
  }

  /** Invalidating one project never disturbs another project's cache. */
  invalidate(cwd: string, kinds: GitRefreshKind[] = ["status", "branch", "workspace"]): void {
    const record = this.record(cwd);
    kinds.forEach((kind) => record.invalidated.add(kind));
    record.generation += 1;
    // Do not let obsolete work occupy the project/global concurrency budget.
    record.inFlight?.controller.abort();
    record.inFlight = undefined;
    record.status = { state: "refreshing", startedAt: Date.now() };
  }

  /**
   * Runs one write to a project's repository after the writes queued before it,
   * and stales the project's cache once it settles, whether it worked or not.
   */
  write<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const record = this.record(cwd);
    const result = (record.writing ?? Promise.resolve()).then(run, run).finally(() => this.invalidate(cwd));
    const settled = result.catch(() => undefined);
    record.writing = settled;
    void settled.then(() => { if (record.writing === settled) record.writing = undefined; });
    return result;
  }

  metrics(): GitCoordinatorMetrics {
    return { ...this.metricsValue };
  }

  private runCoordinated(
    path: string,
    args: string[],
    maxBuffer: number | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    return this.semaphore.run(async () => {
      this.metricsValue.subprocesses += 1;
      this.onSubprocess?.();
      this.metricsValue.activeSubprocesses += 1;
      this.metricsValue.maxParallelSubprocesses = Math.max(
        this.metricsValue.maxParallelSubprocesses,
        this.metricsValue.activeSubprocesses,
      );
      try {
        return await this.runGit(path, args, maxBuffer, signal);
      } finally {
        this.metricsValue.activeSubprocesses -= 1;
      }
    }, signal);
  }

  private record(cwd: string): ProjectRecord {
    let record = this.projects.get(cwd);
    if (!record) {
      record = { generation: 0, invalidated: new Set(), status: { state: "ready" } };
      this.projects.set(cwd, record);
    }
    return record;
  }

  private async cancelForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  }
}
