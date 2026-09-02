import { describe, expect, it } from "vitest";
import type { UiWorkspaceChanges, WorkspaceInfo } from "../../shared/contracts";
import { parseShellActionDraft, resolveGitQuickAction } from "./workspace-actions";

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
    expect(resolveGitQuickAction(clean, workspace({ upstream: "origin/main" }), false)).toMatchObject({
      label: "Up to date",
      kind: "none",
      disabled: true,
    });
  });
});

describe("project shell actions", () => {
  it("defaults to hidden output and honors explicit Pi bang prefixes", () => {
    expect(parseShellActionDraft("npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("!! npm test")).toEqual({ command: "npm test", includeInContext: false });
    expect(parseShellActionDraft("! npm test")).toEqual({ command: "npm test", includeInContext: true });
  });
});
