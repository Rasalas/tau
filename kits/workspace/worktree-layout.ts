import { basename } from "node:path";
import type { UiWorktree } from "tau/host-extension";
import { unquoteGitPath } from "./git-output.js";

/**
 * `git worktree list --porcelain -z` emits NUL-separated fields and records; the first
 * record is always the repository's primary checkout.
 */
export function parseWorktrees(stdout: string, cwd: string): UiWorktree[] {
  const worktrees: UiWorktree[] = [];
  const separator = stdout.includes("\0") ? "\0" : "\n";
  for (const block of stdout.split(separator + separator)) {
    const fields = block.split(separator);
    const encodedPath = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    if (!encodedPath) continue;
    // NUL-delimited fields contain literal paths, including leading quotes and newlines.
    const path = separator === "\0" ? encodedPath : unquoteGitPath(encodedPath);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length)
      ?? (fields.includes("detached") ? "detached" : undefined);
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
