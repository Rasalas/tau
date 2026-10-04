// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopExtensionContext, UiWorkspaceChanges, WorkbenchActions } from "tau";
import { createMemoryStorage, ClientStorageProvider, PreferencesStore, RendererServicesProvider } from "../../src/renderer/test-support/kit-harness.js";
import { ReviewCommentStore } from "./comments.js";
import { createReviewOverlay } from "./overlay.js";
import type { WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceChangesReader } from "./workspace.js";

afterEach(cleanup);

it("resets a stage branch comparison and selected file when its workspace changes", async () => {
  const changes = (path: string): UiWorkspaceChanges => ({ files: [{ path, name: path, directory: "", status: "modified", added: 1, removed: 0 }], added: 1, removed: 0 });
  let state = { workspaceId: "workspace-a", changes: changes("a.ts"), committing: false };
  const listeners = new Set<() => void>();
  const preferences = new PreferencesStore();
  preferences.setOption("tau.review", "propose-message", false);
  const store = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activeEditor: () => undefined,
    refresh: vi.fn(async () => undefined),
    suggestCommitMessage: vi.fn(async () => undefined),
    openInEditor: vi.fn(), closeReview: vi.fn(), selectReviewPath: vi.fn(), commit: vi.fn(),
  } as unknown as WorkspaceStoreApi;
  const reads: { workspace: string; path: string; scope?: string; baseCommit?: string }[] = [];
  const reader: WorkspaceChangesReader = {
    changes: async () => ({ ...changes("a-branch.ts"), scope: "branch", baseRef: "main", baseCommit: "a-base" }),
    fileDiff: async (path, options) => {
      reads.push({ workspace: state.workspaceId, path, scope: options?.scope, baseCommit: options?.baseCommit });
      return { path, added: 1, removed: 0, hunks: [] };
    },
  };
  const StageReview = createReviewOverlay({ preferences } as DesktopExtensionContext, reader, store, new ReviewCommentStore(() => undefined), () => undefined, true);
  render(<ClientStorageProvider storage={createMemoryStorage()}><RendererServicesProvider services={{ preferences }}>
    <StageReview actions={{} as WorkbenchActions} onClose={vi.fn()} />
  </RendererServicesProvider></ClientStorageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Branch vs target" }));
  await screen.findByRole("button", { name: "Mark viewed a-branch.ts" });
  fireEvent.click(within(document.querySelector(".review-tree") as HTMLElement).getByTitle("a-branch.ts"));
  await waitFor(() => expect(reads.some((read) => read.path === "a-branch.ts" && read.baseCommit === "a-base")).toBe(true));
  const beforeSwitch = reads.length;
  act(() => { state = { workspaceId: "workspace-b", changes: changes("b.ts"), committing: false }; listeners.forEach((listener) => listener()); });
  await screen.findByRole("button", { name: "Mark viewed b.ts" });
  expect(screen.queryByRole("button", { name: "Mark viewed a-branch.ts" })).toBeNull();
  await waitFor(() => expect(reads.slice(beforeSwitch)).toContainEqual({ workspace: "workspace-b", path: "b.ts", scope: "worktree", baseCommit: undefined }));
  expect(reads.slice(beforeSwitch).some((read) => read.workspace === "workspace-b" && (read.path === "a-branch.ts" || read.baseCommit === "a-base"))).toBe(false);
  expect(screen.queryByRole("button", { name: "Back to thread" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Commit" })).toBeNull();
});
