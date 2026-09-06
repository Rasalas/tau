// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub, type WorkspaceHostStubOverrides } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { WorkspaceStore } from "./store.js";

/** A store over the kit's own command names, answered by the stub. */
function storeOver(overrides: WorkspaceHostStubOverrides): WorkspaceStore {
  const stub = workspaceHostStub(overrides);
  setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
  return new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
}

afterEach(() => { setHostClient(undefined); vi.restoreAllMocks(); });

describe("Workspace Kit worktree creation", () => {
  it("names the draft's project, then opens the worktree with the composer text", async () => {
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/draft-project-worktrees/fix-queue" }));
    const workspaceStore = storeOver({ createWorktree });
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
    const workspaceStore = storeOver({ createWorktree: async () => { throw new Error("fix/queue is already checked out in a worktree."); } });
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
