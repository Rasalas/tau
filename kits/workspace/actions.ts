import type { UiWorkspaceChanges, WorkspaceInfo } from "tau";

export type GitQuickActionKind = "commit" | "commit-push" | "pull" | "push" | "request" | "none";

export interface GitQuickAction {
  label: string;
  kind: GitQuickActionKind;
  disabled: boolean;
  hint: string;
}

/**
 * `request` is set when the branch is committed, has no request yet and may get one:
 * with nothing left to commit, the request is the next step, not a push.
 */
export function resolveGitQuickAction(
  changes: UiWorkspaceChanges,
  workspace: WorkspaceInfo | undefined,
  busy: boolean,
  request?: { noun: string },
): GitQuickAction {
  if (busy) return { label: "Working…", kind: "none", disabled: true, hint: "Git action in progress" };
  if (!workspace?.isRepo) return { label: "Commit", kind: "none", disabled: true, hint: "This folder is not a Git repository" };
  if (workspace.branch === "detached") return { label: "Commit", kind: "none", disabled: true, hint: "Check out a branch before committing" };

  const ahead = workspace.ahead ?? 0;
  const behind = workspace.behind ?? 0;
  if (ahead > 0 && behind > 0) {
    return { label: "Sync required", kind: "none", disabled: true, hint: "The branch has diverged from its upstream" };
  }
  if (behind > 0) return { label: "Pull", kind: "pull", disabled: false, hint: `Pull ${behind} upstream ${behind === 1 ? "commit" : "commits"}` };

  if (changes.files.length > 0) {
    return workspace.upstream
      ? { label: "Commit & push", kind: "commit-push", disabled: false, hint: `${changes.files.length} changed files` }
      : { label: "Commit", kind: "commit", disabled: false, hint: `${changes.files.length} changed files · no upstream` };
  }
  if (request) {
    const pushed = Boolean(workspace.upstream) && ahead === 0;
    return { label: `Create ${request.noun}`, kind: "request", disabled: false, hint: `Write the ${request.noun} for ${workspace.branch}${pushed ? "" : "; the branch is pushed when it is created"}` };
  }
  if (ahead > 0 && workspace.upstream) {
    return { label: "Push", kind: "push", disabled: false, hint: `${ahead} local ${ahead === 1 ? "commit" : "commits"} to push` };
  }
  return { label: "Up to date", kind: "none", disabled: true, hint: "No changes or local commits to publish" };
}

export interface ShellActionCommand {
  command: string;
  includeInContext: boolean;
}

/** Pi uses ! for visible shell output and !! for output excluded from model context. */
export function parseShellActionDraft(value: string): ShellActionCommand {
  const trimmed = value.trim();
  if (trimmed.startsWith("!!")) return { command: trimmed.slice(2).trim(), includeInContext: false };
  if (trimmed.startsWith("!")) return { command: trimmed.slice(1).trim(), includeInContext: true };
  return { command: trimmed, includeInContext: false };
}
