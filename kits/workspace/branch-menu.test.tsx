// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { CheckoutMenu } from "./branch-menu.js";
import { createWorkspaceHostClient, type UiWorktreeRemoval } from "./protocol.js";
import { WorkspaceStore } from "./store.js";
import { withWorkspaceStore } from "./store-context.js";

afterEach(cleanup);

function menu(preview: Promise<UiWorktreeRemoval>) {
  const host = createWorkspaceHostClient(async (command) => command === "worktree-removal-preview" ? preview : []);
  const store = new WorkspaceStore(new PreferencesStore(), host);
  store.update({ cwd: "/repo", workspace: {
    root: "/repo", isRepo: true, isDirty: false, branch: "main", refs: [], worktreeParent: "/trees",
    worktrees: [{ path: "/trees/manual", name: "manual", branch: "manual", isMain: false, isCurrent: false }],
  } });
  const remove = vi.spyOn(store, "removeWorktree").mockResolvedValue(true);
  const Bound = withWorkspaceStore(store, CheckoutMenu);
  render(<Bound onDone={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove manual" }));
  return remove;
}

describe("worktree removal confirmation", () => {
  it("waits for the preview before enabling Remove", async () => {
    let resolve!: (preview: UiWorktreeRemoval) => void;
    const remove = menu(new Promise((ready) => { resolve = ready; }));
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Remove" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
    resolve({ path: "/trees/manual", branch: "manual", dirtyFiles: 0, ahead: 1, unpushedCommits: 1, ignoredFiles: 0, openThreads: 0 });
    await screen.findByText(/1 unpushed commit/u);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledWith("/trees/manual", "manual", { force: false, forceBranch: false });
  });

  it("keeps Remove disabled when inspection fails", async () => {
    const remove = menu(Promise.reject(new Error("Cannot inspect worktree")));
    await screen.findByText("Cannot inspect worktree");
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Remove" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires a separate confirmation for local files and sends branch deletion only when checked", async () => {
    const remove = menu(Promise.resolve({ path: "/trees/manual", branch: "manual", dirtyFiles: 1, ahead: 1, unpushedCommits: 1, ignoredFiles: 1, openThreads: 0 }));
    const discard = await screen.findByRole("checkbox", { name: "Discard uncommitted and ignored files" });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Remove" });
    expect(button.disabled).toBe(true);
    const branch = screen.getByRole<HTMLInputElement>("checkbox", { name: "Delete branch even if unmerged" });
    expect(branch.checked).toBe(false);
    fireEvent.click(branch);
    expect(button.disabled).toBe(true);
    fireEvent.click(discard);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledWith("/trees/manual", "manual", { force: true, forceBranch: true });
  });

  it("requires confirmation before discarding detached commits", async () => {
    const remove = menu(Promise.resolve({ path: "/trees/manual", dirtyFiles: 0, ahead: 1, unpushedCommits: 1, ignoredFiles: 0, openThreads: 0 }));
    const discard = await screen.findByRole("checkbox", { name: "Discard detached worktree's unpushed commits" });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Remove" });
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Delete branch even if unmerged" })).toBeNull();
    fireEvent.click(discard);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledWith("/trees/manual", undefined, { force: false, forceBranch: true });
  });

  it("keeps Remove disabled while a thread is open", async () => {
    const remove = menu(Promise.resolve({ path: "/trees/manual", branch: "manual", dirtyFiles: 0, ahead: 0, unpushedCommits: 0, ignoredFiles: 0, openThreads: 1 }));
    await screen.findByText(/1 open thread/u);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Remove" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });
});
