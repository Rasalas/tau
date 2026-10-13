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
  const request = { noun: "PR" };

  it("leads with the request once nothing is left to commit", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat", ahead: 2 }), false, request)).toMatchObject({ label: "Create PR", kind: "request", disabled: false });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat" }), false, request).hint).toBe("Write the PR for main");
    // A branch without an upstream is pushed when the request is created.
    expect(resolveGitQuickAction(clean, workspace(), false, { noun: "MR" })).toMatchObject({ label: "Create MR", kind: "request" });
    expect(resolveGitQuickAction(clean, workspace(), false, request).hint).toContain("pushed when it is created");
  });

  it("commits first, and syncs before it leads anywhere", () => {
    expect(resolveGitQuickAction(dirty, workspace({ upstream: "origin/main" }), false, request)).toMatchObject({ label: "Commit & push", kind: "commit-push" });
    expect(resolveGitQuickAction(dirty, workspace(), false, request)).toMatchObject({ label: "Commit", kind: "commit" });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", behind: 1 }), false, request)).toMatchObject({ kind: "pull" });
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main", ahead: 1, behind: 1 }), false, request)).toMatchObject({ kind: "none", disabled: true });
    expect(resolveGitQuickAction(clean, workspace({ branch: "detached" }), false, request)).toMatchObject({ kind: "none", disabled: true });
  });

  it("keeps the push when no request is offered", () => {
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/feat", ahead: 2 }), false)).toMatchObject({ label: "Push", kind: "push" });
  });
});

describe("project shell actions", () => {
  it("defaults to hidden output and honors explicit Pi bang prefixes", () => {
    expect(parseShellActionDraft("npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("!! npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("! npm test")).toEqual({ command: "npm test", includeInContext: true });
  });
});
