// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "../extension-system";
import { setHostClient } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { workspaceHostStub } from "../test-support/workspace-host-stub";
import { PreferencesStore } from "../preferences";
import { WorkspaceStore } from "./workspace-store";

afterEach(() => { setHostClient(undefined); vi.restoreAllMocks(); });

describe("Workspace Kit worktree creation", () => {
  it("names the draft's project, then opens the worktree with the composer text", async () => {
    const workspaceStore = new WorkspaceStore(new PreferencesStore());
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/draft-project-worktrees/fix-queue" }));
    setHostClient(createFakeHostClient({ invokeHostExtension: workspaceHostStub({ createWorktree }) }));
    const release = vi.fn();
    const actions = {
      holdComposer: vi.fn(() => release),
      openWorkspace: vi.fn(async () => true),
      notify: vi.fn(),
    } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);
    workspaceStore.update({ cwd: "/draft-project", workspaceId: "ws1_draft-project", draftPending: true });

    await expect(workspaceStore.createWorktree("fix/queue", "main")).resolves.toBe(true);

    // The draft's project and the new worktree are both named by identity, never by path.
    expect(createWorktree).toHaveBeenCalledWith("fix/queue", "main", "ws1_draft-project");
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws1_worktree", { inheritDraft: true });
    expect(actions.holdComposer).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(workspaceStore.getSnapshot().workspaceBusy).toBe(false);
  });

  it("reports a failed creation and releases the composer", async () => {
    const workspaceStore = new WorkspaceStore(new PreferencesStore());
    setHostClient(createFakeHostClient({ invokeHostExtension: workspaceHostStub({ createWorktree: async () => { throw new Error("fix/queue is already checked out in a worktree."); } }) }));
    const release = vi.fn();
    const actions = { holdComposer: () => release, openWorkspace: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);
    workspaceStore.update({ cwd: "/project", draftPending: false });

    await expect(workspaceStore.createWorktree("fix/queue")).resolves.toBe(false);
    expect(actions.notify).toHaveBeenCalledWith("fix/queue is already checked out in a worktree.");
    expect(actions.openWorkspace).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
