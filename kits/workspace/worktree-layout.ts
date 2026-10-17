import { basename } from "node:path";
import type { UiWorktree } from "tau/host-extension";

/**
 * `git worktree list --porcelain` emits blank-line separated records; the first
 * record is always the repository's primary checkout.
 */
export function parseWorktrees(stdout: string, cwd: string): UiWorktree[] {
  const worktrees: UiWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1] ?? (/^detached$/mu.test(block) ? "detached" : undefined);
    worktrees.push({
      path,
      name: basename(path),
      branch,
      isMain: worktrees.length === 0,
      isCurrent: path === cwd,
    });
  }
  return worktrees;
}
