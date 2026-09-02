// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../shared/workspace-kit-types";
import { WorkspaceBar } from "./WorkspaceBar";

const handlers = {
  onOpenWorktree: vi.fn(async () => true),
  onCreateWorktree: vi.fn(async () => true),
  onSwitchRef: vi.fn(async () => true),
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    root: "/Users/dev/code/tau",
    isRepo: true,
    isDirty: false,
    branch: "main",
    worktrees: [{
      path: "/Users/dev/code/tau",
      name: "tau",
      branch: "main",
      isMain: true,
      isCurrent: true,
    }],
    refs: [],
    worktreeParent: "/Users/dev/code/tau-worktrees",
    ...patch,
  };
}

function setup(info: WorkspaceInfo) {
  render(<WorkspaceBar info={info} busy={false} {...handlers} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceBar", () => {
  it("shows the active linked worktree name in the bottom-left chip", () => {
    setup(workspace({
      root: "/Users/dev/code/tau-worktrees/feat-worktree-label",
      branch: "feat/worktree-label",
      worktrees: [
        {
          path: "/Users/dev/code/tau",
          name: "tau",
          branch: "main",
          isMain: true,
          isCurrent: false,
        },
        {
          path: "/Users/dev/code/tau-worktrees/feat-worktree-label",
          name: "feat-worktree-label",
          branch: "feat/worktree-label",
          isMain: false,
          isCurrent: true,
        },
      ],
    }));

    expect(screen.getByRole("button", { name: "feat-worktree-label" })).toBeTruthy();
  });

  it("lets a new worktree start from origin/main", () => {
    setup(workspace({ hasRemote: true }));
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "New worktree…" }));
    fireEvent.change(screen.getByPlaceholderText("feat/my-branch"), { target: { value: "feat/remote-base" } });
    fireEvent.change(screen.getByRole("combobox", { name: "START FROM" }), { target: { value: "origin/main" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(handlers.onCreateWorktree).toHaveBeenCalledWith("feat/remote-base", "origin/main");
  });

  it("shows a sibling-relative path when creating a worktree", () => {
    setup(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "New worktree…" }));
    fireEvent.change(screen.getByPlaceholderText("feat/my-branch"), {
      target: { value: "feat/short-path" },
    });

    expect(screen.getByText("../tau-worktrees/feat-short-path")).toBeTruthy();
    expect(screen.queryByText(/Users\/dev\/code/u)).toBeNull();
  });
});
