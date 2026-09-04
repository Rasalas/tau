// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff, UiWorkspaceChanges } from "../../shared/workspace-kit-types";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { ReviewMode } from "./ReviewMode";

let storage: ClientStorage;

/** Wraps a `<ReviewMode>` element in the same storage the test's `beforeEach` installed ambiently. */
function withStorage(node: ReactElement): ReactElement {
  return <ClientStorageProvider storage={storage}>{node}</ClientStorageProvider>;
}

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

const ROW_HEIGHT = 26;
const VIEWPORT_HEIGHT = 260;

function stubbedHeight(element: HTMLElement): number {
  if (element.classList.contains("review-diff-stream")) return VIEWPORT_HEIGHT;
  return element.classList.contains("diff-stream-row") ? ROW_HEIGHT : 0;
}

/** jsdom reports no layout. Give the diff virtualizer a viewport and uniform rows. */
function stubDiffLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measure(this: HTMLElement) {
    const height = stubbedHeight(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: height, width: 900, height, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function height(this: HTMLElement) {
    return stubbedHeight(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value(this: Element, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
      this.dispatchEvent(new Event("scroll"));
    },
  });
}

describe("ReviewMode", () => {
  beforeEach(() => { storage = createMemoryStorage(); setClientStorage(storage); });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); setClientStorage(undefined); });

  it("switches to branch changes and persists viewed files and line notes", async () => {
    const onSelect = vi.fn();
    const loadChanges = vi.fn(async () => branch);
    render(withStorage(<ReviewMode
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
    />));

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
    const view = render(withStorage(<ReviewMode changes={worktree} {...props} />));

    await waitFor(() => expect(document.querySelector(".diff-code")?.textContent).toContain("const stable = true;"));
    view.rerender(withStorage(<ReviewMode
      changes={{ ...worktree, files: worktree.files.map((file) => ({ ...file })) }}
      {...props}
    />));

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
    render(withStorage(<ReviewMode
      changes={changes}
      selectedPath="src/a.ts"
      busy={false}
      primaryPush={false}
      onSelect={onSelect}
      onBack={() => undefined}
      onCommit={() => undefined}
      onOpenInEditor={() => undefined}
      loadDiff={loadDiff}
    />));

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

  it("windows every file into one virtualized stream and jumps to a file on demand", async () => {
    stubDiffLayout();
    const files = ["src/a.ts", "src/b.ts"].map((path) => ({
      path,
      name: path.slice(4),
      directory: "src",
      status: "modified" as const,
      added: 400,
      removed: 0,
    }));
    const changes: UiWorkspaceChanges = { branch: "feat/review", files, fileCount: 2, added: 800, removed: 0 };
    const loadDiff = async (path: string): Promise<UiFileDiff> => ({
      path,
      added: 400,
      removed: 0,
      hunks: [{
        header: "@@ -1 +1 @@",
        lines: Array.from({ length: 400 }, (_, index) => ({ kind: "added" as const, newLine: index + 1, text: `${path} line ${index};` })),
      }],
    });
    const { container } = render(withStorage(<ReviewMode
      changes={changes}
      selectedPath="src/a.ts"
      busy={false}
      primaryPush={false}
      onSelect={() => undefined}
      onBack={() => undefined}
      onCommit={() => undefined}
      onOpenInEditor={() => undefined}
      loadDiff={loadDiff}
    />));

    await waitFor(() => expect(container.textContent).toContain("src/a.ts line 0;"));
    // 804 rows exist; only the window plus overscan may be mounted.
    expect(container.querySelectorAll(".diff-stream-row").length).toBeLessThan(40);
    expect(container.textContent).not.toContain("src/b.ts line 0;");

    fireEvent.click(screen.getByTitle("src/b.ts"));
    await waitFor(() => expect(container.textContent).toContain("src/b.ts line 0;"));
    expect(container.textContent).not.toContain("src/a.ts line 0;");
    expect(container.querySelectorAll(".diff-stream-row").length).toBeLessThan(40);
  });
});
