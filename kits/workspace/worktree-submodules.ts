import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeSubmodules } from "./protocol.js";
import { runGitCommand, type GitRunner } from "./workspace-git.js";

/** A first checkout of a submodule may clone over the network. */
const SUBMODULE_TIMEOUT_MS = 10 * 60 * 1000;

const longGit: GitRunner = (cwd, args, maxBuffer, signal) => runGitCommand(cwd, args, maxBuffer ?? 8 * 1024 * 1024, signal, undefined, SUBMODULE_TIMEOUT_MS);

export interface SubmoduleResult {
  mode: WorktreeSubmodules;
  /** False when git failed; the worktree stays, with empty submodule folders. */
  ok: boolean;
  detail?: string;
}

/**
 * `git worktree add` leaves submodules empty. This fills them the way the
 * setting (else the checkout's `.tau/project.json`, else recursive) says.
 * `undefined` when the checkout declares no submodules; a failure is reported,
 * never thrown, because the thread can still start without them.
 */
export async function initWorktreeSubmodules(
  worktree: string,
  mode: WorktreeSubmodules | undefined,
  options: { onStart?(mode: WorktreeSubmodules): void; runGit?: GitRunner } = {},
): Promise<SubmoduleResult | undefined> {
  const declared = await stat(join(worktree, ".gitmodules")).then((entry) => entry.isFile(), () => false);
  if (!declared) return undefined;
  const chosen = mode ?? "recursive";
  if (chosen === "none") return { mode: chosen, ok: true };
  options.onStart?.(chosen);
  const args = ["submodule", "update", "--init", ...(chosen === "recursive" ? ["--recursive"] : [])];
  try {
    await (options.runGit ?? longGit)(worktree, args);
    return { mode: chosen, ok: true };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    return { mode: chosen, ok: false, ...(detail ? { detail } : {}) };
  }
}
