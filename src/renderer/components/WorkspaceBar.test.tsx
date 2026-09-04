// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("offers the typed name as a new worktree above the matches, and not when a worktree carries it", async () => {
    const linked = { path: "/Users/dev/code/tau-worktrees/feat-new-thing", name: "feat-new-thing", branch: "feat/new-thing", isMain: false, isCurrent: false };
    setup(workspace({ hasRemote: true, worktrees: [workspace().worktrees[0], linked] }));
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    const search = await screen.findByRole("searchbox", { name: "Search worktrees" });

    fireEvent.change(search, { target: { value: "feat/new" } });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Create worktree “feat/new”");
    expect(options[0].textContent).toContain("with exactly this name · from origin/main · ../tau-worktrees/feat-new");
    expect(options[1].textContent).toContain("feat/new-thing");
    // Enter still opens the best match; the new-worktree row is one ArrowUp away.
    expect(options[1].classList.contains("selected")).toBe(true);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(handlers.onOpenWorktree).toHaveBeenCalledWith(linked.path);

    fireEvent.change(search, { target: { value: "feat/new-thing" } });
    expect(screen.queryByRole("option", { name: /Create worktree/u })).toBeNull();

    fireEvent.change(search, { target: { value: "fix/worktree-handling" } });
    fireEvent.click(screen.getByRole("option", { name: /Create worktree “fix\/worktree-handling”/u }));
    expect(handlers.onCreateWorktree).toHaveBeenCalledWith("fix/worktree-handling", "origin/main");
  });

  it("branches a new worktree off the current branch when the repository has no remote", async () => {
    setup(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search worktrees" }), { target: { value: "fix/local" } });
    fireEvent.click(screen.getByRole("option", { name: /Create worktree “fix\/local”/u }));
    expect(handlers.onCreateWorktree).toHaveBeenCalledWith("fix/local", "main");
  });

  it("creates the typed name with Enter when nothing else matches", async () => {
    setup(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    const search = await screen.findByRole("searchbox", { name: "Search worktrees" });
    fireEvent.change(search, { target: { value: "fix/only-new" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(handlers.onCreateWorktree).toHaveBeenCalledWith("fix/only-new", "main");
  });


  it("offers automatic naming only with a namer, and puts the suggestion into the search to review", async () => {
    setup(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    await screen.findByRole("searchbox", { name: "Search worktrees" });
    expect(screen.queryByRole("button", { name: /automatic naming/u })).toBeNull();
    cleanup();

    const onSuggestName = vi.fn(async () => "fix/steer-queue-messages");
    render(<WorkspaceBar info={workspace()} busy={false} {...handlers} onSuggestName={onSuggestName} />);
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search worktrees" }), { target: { value: "steer" } });
    fireEvent.click(screen.getByRole("button", { name: /automatic naming/u }));
    expect(onSuggestName).toHaveBeenCalledWith("steer");
    const search = screen.getByRole("searchbox", { name: "Search worktrees" }) as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe("fix/steer-queue-messages"));
    expect(screen.getByRole("option", { name: /Create worktree “fix\/steer-queue-messages”/u }).classList.contains("selected")).toBe(true);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(handlers.onCreateWorktree).toHaveBeenCalledWith("fix/steer-queue-messages", "main");
  });

  it("closes the picker on a click outside of the bar", async () => {
    setup(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Current checkout" }));
    await screen.findByRole("searchbox", { name: "Search worktrees" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("searchbox", { name: "Search worktrees" })).toBeNull();
  });


});
