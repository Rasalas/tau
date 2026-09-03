// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiWorktreeStatus, WorkspaceInfo } from "../../shared/workspace-kit-types";
import { WorkspaceBar } from "./WorkspaceBar";

const styles = readFileSync("src/renderer/styles.css", "utf8");

const handlers = {
  onOpenWorktree: vi.fn(async () => true),
  onCreateWorktree: vi.fn(async () => true),
  onSwitchRef: vi.fn(async () => true),
  onLoadWorktreeStatuses: vi.fn(async (): Promise<UiWorktreeStatus[]> => []),
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

  it("bounds and fuzzy-filters a long worktree list", async () => {
    const worktrees = [
      workspace().worktrees[0],
      ...Array.from({ length: 30 }, (_, index) => ({
        path: `/Users/dev/code/tau-worktrees/feature-${index}`,
        name: `feature-${index}`,
        branch: index === 17 ? "feat/renderer-search" : `feat/issue-${index}`,
        isMain: false,
        isCurrent: false,
      })),
    ];
    setup(workspace({ worktrees }));

    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));

    const search = await screen.findByRole("searchbox", { name: "Search worktrees" });
    expect(search.closest(".workspace-menu")).toBeTruthy();
    expect(styles).toMatch(/\.workspace-menu\s*\{[^}]*max-height:\s*min\(470px,\s*calc\(100vh - 96px\)\)/u);
    expect(screen.getByRole("listbox", { name: "Worktrees" }).classList.contains("worktree-list")).toBe(true);

    fireEvent.change(search, { target: { value: "rndrsrch" } });
    expect(screen.getByRole("option", { name: /feat\/renderer-search/u })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /feat\/issue-2/u })).toBeNull();
  });

  it("shows cleanup safety status without hiding unsafe worktrees", async () => {
    const linked = {
      path: "/Users/dev/code/tau-worktrees/feat-safe",
      name: "feat-safe",
      branch: "feat/safe",
      isMain: false,
      isCurrent: false,
    };
    handlers.onLoadWorktreeStatuses.mockResolvedValueOnce([{
      path: linked.path,
      isDirty: false,
      upstream: "origin/feat/safe",
      ahead: 0,
      behind: 2,
      threadCount: 0,
      lastCommitAt: Date.now() - 30 * 24 * 60 * 60 * 1_000,
      cleanupCandidate: true,
    }]);
    setup(workspace({ worktrees: [workspace().worktrees[0], linked] }));

    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));

    expect(await screen.findByText("cleanup candidate")).toBeTruthy();
    expect(screen.getByText("clean · behind 2 · unused")).toBeTruthy();
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
