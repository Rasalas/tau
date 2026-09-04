// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
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
  request: { provider: "github", number: 42, title: "Add review bases", url: "https://github.com/acme/tau/pull/42", baseRef: "main" },
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
    expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toBe("https://github.com/acme/tau/pull/42");
  });

  it("keeps loaded diffs mounted while a workspace refresh revalidates them", async () => {
    let resolveRefresh!: (diff: UiFileDiff) => void;
    const initialDiff = async (path: string) => ({
      path,
      added: 1,
      removed: 0,
      hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added" as const, newLine: 1, text: "const stable = true;" }] }],
    });
    const loadDiff = vi.fn((path: string) => loadDiff.mock.calls.length === 1
      ? initialDiff(path)
      : new Promise<UiFileDiff>((resolve) => { resolveRefresh = resolve; }));
    const props = {
      selectedPath: "src/a.ts",
      busy: false,
      primaryPush: false,
      onSelect: () => undefined,
      onBack: () => undefined,
      onCommit: () => undefined,
      onOpenInEditor: () => undefined,
      loadDiff,
    };
    const view = render(<ReviewMode changes={worktree} {...props} />);

    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const stable = true;"));
    view.rerender(<ReviewMode
      changes={{ ...worktree, files: worktree.files.map((file) => ({ ...file })) }}
      {...props}
    />);

    await waitFor(() => expect(loadDiff).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Loading diff…")).toBeNull();
    expect(document.querySelector(".diff-code")?.textContent).toContain("const stable = true;");

    resolveRefresh({
      ...await initialDiff("src/a.ts"),
      hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "added", newLine: 1, text: "const stable = false;" }] }],
    });
    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const stable = false;"));
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

    await waitFor(() => {
      expect(loadDiff).toHaveBeenCalledWith("src/a.ts", expect.objectContaining({ contextLines: 3 }));
      expect(loadDiff).toHaveBeenCalledWith("src/nested/b.ts", expect.objectContaining({ contextLines: 3 }));
    });
    fireEvent.click(screen.getByRole("button", { name: "All lines" }));
    await waitFor(() => {
      expect(loadDiff).toHaveBeenCalledWith("src/a.ts", expect.objectContaining({ contextLines: 100_000 }));
      expect(loadDiff).toHaveBeenCalledWith("src/nested/b.ts", expect.objectContaining({ contextLines: 100_000 }));
    });

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
