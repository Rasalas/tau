import { describe, expect, it } from "vitest";
import type { UiWorkspaceChanges, WorkspaceInfo } from "tau";
import { parseShellActionDraft, resolveGitQuickAction } from "./actions.js";

const clean: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const dirty: UiWorkspaceChanges = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1,
  removed: 0,
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    root: "/project",
    isRepo: true,
    isDirty: false,
    branch: "main",
    worktrees: [],
    refs: [],
    worktreeParent: "/worktrees",
    ...patch,
  };
}

describe("title-bar Git action", () => {
  it("offers commit and push only when the current branch has an upstream", () => {
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true, upstream: "origin/main" }), false)).toMatchObject({
      label: "Commit & push",
      kind: "commit-push",
      disabled: false,
    });
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true }), false)).toMatchObject({
      label: "Commit",
      kind: "commit",
      disabled: false,
    });
  });

  it("offers push for committed local work and blocks unsafe sync states", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", ahead: 2 }), false)).toMatchObject({
      label: "Push",
      kind: "push",
      disabled: false,
    });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", ahead: 1, behind: 1 }), false)).toMatchObject({
      label: "Sync required",
      disabled: true,
    });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", behind: 2 }), false)).toMatchObject({
      label: "Pull",
      kind: "pull",
      disabled: false,
    });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main" }), false)).toMatchObject({
      label: "Up to date",
      kind: "none",
      disabled: true,
    });
  });
});

describe("title-bar Git action leading to a request", () => {
  const committed = { noun: "PR", committed: true };
  const uncommitted = { noun: "PR", committed: false };

  it("leads with the request once nothing is left to commit", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat", ahead: 2 }), false, committed)).toMatchObject({ label: "Create PR", kind: "request", disabled: false });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat" }), false, committed).hint).toBe("Write the PR for main");
    // A branch without an upstream is pushed when the request is created.
    expect(resolveGitQuickAction(clean, workspace(), false, { noun: "MR", committed: true })).toMatchObject({ label: "Create MR", kind: "request" });
    expect(resolveGitQuickAction(clean, workspace(), false, committed).hint).toContain("pushed when it is created");
    // Nothing committed is nothing to open a request for.
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat" }), false, uncommitted)).toMatchObject({ label: "Up to date", disabled: true });
  });

  it("leads changed files through the commit, the push and the request in one go", () => {
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true }), false, uncommitted)).toMatchObject({ label: "Commit, push & PR", kind: "commit-request", disabled: false });
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true, upstream: "origin/feat" }), false, { noun: "MR", committed: true })).toMatchObject({ label: "Commit, push & MR", kind: "commit-request" });
    // Without a remote there is nothing to push or open a request on.
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true, hasRemote: false }), false, uncommitted)).toMatchObject({ label: "Commit", kind: "commit" });
  });

  it("syncs before it leads anywhere", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", behind: 1 }), false, committed)).toMatchObject({ kind: "pull" });
    expect(resolveGitQuickAction(dirty, workspace({ upstream: "origin/main", behind: 1 }), false, uncommitted)).toMatchObject({ kind: "pull" });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", ahead: 1, behind: 1 }), false, committed)).toMatchObject({ kind: "none", disabled: true });
    expect(resolveGitQuickAction(clean, workspace({ branch: "detached" }), false, committed)).toMatchObject({ kind: "none", disabled: true });
  });

  it("keeps commit and push when no request is offered", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat", ahead: 2 }), false)).toMatchObject({ label: "Push", kind: "push" });
    expect(resolveGitQuickAction(dirty, workspace({ isDirty: true, upstream: "origin/feat" }), false)).toMatchObject({ label: "Commit & push", kind: "commit-push" });
  });
});

describe("project shell actions", () => {
  it("defaults to hidden output and honors explicit Pi bang prefixes", () => {
    expect(parseShellActionDraft("npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("!! npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("! npm test")).toEqual({ command: "npm test", includeInContext: true });
  });
});
