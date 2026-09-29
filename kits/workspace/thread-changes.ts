import type { UiWorkspaceChanges } from "tau/host-extension";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";

/**
 * What the thread header's "N files changed" counts.
 * - `branch`: the thread has a worktree of its own; its branch against its base, uncommitted work included.
 * - `thread`: a shared checkout; only the uncommitted files this thread's turns changed.
 * - `checkout`: nothing narrower is known (no checkpoints); every uncommitted file.
 */
export interface ThreadChangesCount {
  files: number;
  scope: "branch" | "thread" | "checkout";
  /** Uncommitted files in the checkout, whoever changed them. */
  uncommitted: number;
}

/** Turns looked at for a shared checkout's count; older work has usually been committed. */
export const THREAD_CHANGES_TURNS = 50;

export interface ThreadChangesSources {
  /** Paths committed on the branch since its base; undefined without a base. */
  branchPaths?(): Promise<readonly string[] | undefined>;
  /** The thread's recorded turns, oldest first; undefined when it records none. */
  checkpoints?(): Promise<readonly UiTurnCheckpoint[] | undefined>;
  /** Every file of one turn whose record holds only a preview. */
  turnPaths?(checkpoint: UiTurnCheckpoint): Promise<readonly string[]>;
}

export async function countThreadChanges(status: UiWorkspaceChanges, ownWorktree: boolean, sources: ThreadChangesSources, turnPaths = new Map<string, readonly string[]>()): Promise<ThreadChangesCount> {
  const uncommitted = status.files.map((file) => file.path);
  if (ownWorktree) {
    const committed = await sources.branchPaths?.().catch(() => undefined);
    if (committed) return { files: new Set([...uncommitted, ...committed]).size, scope: "branch", uncommitted: uncommitted.length };
  }
  const checkpoints = await sources.checkpoints?.().catch(() => undefined);
  if (!ownWorktree && checkpoints && checkpoints.length > 0) {
    const touched = new Set<string>();
    for (const checkpoint of checkpoints.slice(-THREAD_CHANGES_TURNS)) {
      for (const path of await pathsOf(checkpoint, sources, turnPaths)) touched.add(path);
    }
    return { files: uncommitted.filter((path) => touched.has(path)).length, scope: "thread", uncommitted: uncommitted.length };
  }
  return { files: uncommitted.length, scope: "checkout", uncommitted: uncommitted.length };
}

/** A turn's files never change once recorded, so each is read once. */
async function pathsOf(checkpoint: UiTurnCheckpoint, sources: ThreadChangesSources, cache: Map<string, readonly string[]>): Promise<readonly string[]> {
  const key = `${checkpoint.sessionId}/${checkpoint.id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const preview = checkpoint.files.map((file) => file.path);
  const complete = (checkpoint.fileCount ?? preview.length) <= preview.length;
  const paths = complete || !sources.turnPaths ? preview : await sources.turnPaths(checkpoint).catch(() => preview);
  if (cache.size >= 5_000) cache.clear();
  cache.set(key, paths);
  return paths;
}
