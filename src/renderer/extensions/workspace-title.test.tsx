// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../shared/workspace-kit-types";
import type { WorkbenchActions } from "../extension-system";
import { WorkspaceTitleActions } from "./workspace-title";
import { workspaceStore } from "./workspace-store";

const dirty = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified" as const, added: 1, removed: 0 }],
  added: 1,
  removed: 0,
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { root: "/project", isRepo: true, isDirty: true, branch: "main", worktrees: [], refs: [], worktreeParent: "/worktrees", ...patch };
}

function setup(info = workspace(), draftPending = false) {
  workspaceStore.update({ cwd: "/project", draftPending, changes: dirty, workspace: info, committing: false, editors: [{ id: "code", name: "VS Code" }, { id: "zed", name: "Zed" }] });
  const openInEditor = vi.spyOn(workspaceStore, "openInEditor").mockResolvedValue(undefined);
  const openReview = vi.spyOn(workspaceStore, "openReview").mockImplementation(() => undefined);
  const runShellAction = vi.spyOn(workspaceStore, "runShellAction").mockResolvedValue(undefined);
  render(<WorkspaceTitleActions actions={{} as WorkbenchActions} />);
  return { openInEditor, openReview, runShellAction };
}

beforeEach(() => { localStorage.clear(); window.tau = { platform: "darwin" } as typeof window.tau; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.tau; });

describe("Workspace Kit title actions", () => {
  it("opens the preferred editor and opens a selected editor from the split menu", () => {
    const { openInEditor } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openInEditor).toHaveBeenCalledWith(undefined, "code");
    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
    expect(openInEditor).toHaveBeenCalledWith(undefined, "zed");
  });

  it("disables editor actions while a draft is pending", () => {
    setup(workspace(), true);
    expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Choose editor" }).hasAttribute("disabled")).toBe(true);
  });

  it("chooses commit versus commit and push from upstream state", () => {
    const withoutUpstream = setup();
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(withoutUpstream.openReview).toHaveBeenCalledWith(undefined, false);
    cleanup();
    vi.restoreAllMocks();

    const withUpstream = setup(workspace({ upstream: "origin/main" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    expect(withUpstream.openReview).toHaveBeenCalledWith(undefined, true);
  });

  it("adds and runs a hidden Pi shell action", () => {
    const { runShellAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.change(screen.getByPlaceholderText("Test"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByPlaceholderText("!! npm test"), { target: { value: "!! npm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(runShellAction).toHaveBeenCalledWith("npm test", false, "Tests");
  });
});
