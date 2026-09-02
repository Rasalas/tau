// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { ReviewMode } from "./ReviewMode";

const worktree: UiWorkspaceChanges = {
  branch: "feat/review",
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  fileCount: 1,
  added: 1,
  removed: 0,
  proposedMessage: "Update a",
};
const branch: UiWorkspaceChanges = {
  branch: "feat/review",
  scope: "branch",
  baseRef: "main",
  files: [{ path: "src/b.ts", name: "b.ts", directory: "src", status: "added", added: 1, removed: 0 }],
  fileCount: 1,
  added: 1,
  removed: 0,
};

describe("ReviewMode", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("switches to branch changes and persists viewed files and line notes", async () => {
    const onSelect = vi.fn();
    const loadChanges = vi.fn(async () => branch);
    render(<ReviewMode
      changes={worktree}
      selectedPath="src/a.ts"
      busy={false}
      primaryPush={false}
      onSelect={onSelect}
      onBack={() => undefined}
      onCommit={() => undefined}
      onOpenInEditor={() => undefined}
      workspaceKey="/repo"
      loadChanges={loadChanges}
      loadDiff={async (path) => ({ path, added: 1, removed: 0, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added", newLine: 1, text: "hello" }] }] })}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Mark viewed src/a.ts" }));
    expect(screen.getByText("1/1 viewed")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 1" }));
    fireEvent.change(screen.getByPlaceholderText("Leave a review note…"), { target: { value: "Check this line" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Check this line")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Branch changes" }));
    await waitFor(() => expect(loadChanges).toHaveBeenCalledWith({ scope: "branch" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("src/b.ts"));
    expect(await screen.findByText("from main")).toBeTruthy();
  });

  it("uses a filterable tree, cycles files, and expands context only on request", async () => {
    const changes: UiWorkspaceChanges = {
      branch: "feat/review",
      files: [
        { path: "src/a.ts", name: "a.ts", directory: "src", status: "modified", added: 1, removed: 0 },
        { path: "src/nested/b.ts", name: "b.ts", directory: "src/nested", status: "added", added: 1, removed: 0 },
      ],
      fileCount: 2,
      added: 2,
      removed: 0,
    };
    const onSelect = vi.fn();
    const loadDiff = vi.fn(async (path: string) => ({
      path,
      added: 1,
      removed: 0,
      hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added" as const, newLine: 1, text: "hello" }] }],
    }));
    render(<ReviewMode
      changes={changes}
      selectedPath="src/a.ts"
      busy={false}
      primaryPush={false}
      onSelect={onSelect}
      onBack={() => undefined}
      onCommit={() => undefined}
      onOpenInEditor={() => undefined}
      loadDiff={loadDiff}
    />);

    await waitFor(() => expect(loadDiff).toHaveBeenCalledWith("src/a.ts", expect.objectContaining({ contextLines: 3 })));
    fireEvent.click(screen.getByRole("button", { name: "All lines" }));
    await waitFor(() => expect(loadDiff).toHaveBeenLastCalledWith("src/a.ts", expect.objectContaining({ contextLines: 100_000 })));

    fireEvent.click(screen.getByRole("button", { name: "Next changed file" }));
    expect(onSelect).toHaveBeenCalledWith("src/nested/b.ts");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), { target: { value: "nested" } });
    expect(screen.getByTitle("src/nested/b.ts")).toBeTruthy();
    expect(screen.queryByTitle("src/a.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle file tree" }));
    expect(screen.getByRole("button", { name: "Toggle file tree" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("searchbox", { name: "Filter changed files" })).toBeNull();
  });
});
