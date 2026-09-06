// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub, type WorkspaceHostStubOverrides } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { WorkspaceStore } from "./store.js";

/** A store over the kit's own command names, answered by the stub. */
function storeOver(overrides: WorkspaceHostStubOverrides, preferences = new PreferencesStore()): WorkspaceStore {
  const stub = workspaceHostStub(overrides);
  setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
  return new WorkspaceStore(preferences, createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
}

const REPO = { root: "/project", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [{ name: "main", isCurrent: true }], worktreeParent: "/project-worktrees" };

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
    expect(createWorktree).toHaveBeenCalledWith("fix/queue", { baseRef: "main", startFromOrigin: true }, "ws1_draft-project");
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

describe("Workspace Kit thread worktrees", () => {
  const actionsWith = (extra: Partial<WorkbenchActions> = {}) => ({
    holdComposer: () => () => undefined,
    openWorkspace: vi.fn(async () => true),
    notify: vi.fn(),
    ...extra,
  } as unknown as WorkbenchActions);

  it("creates the worktree a new thread runs in, named after its first prompt", async () => {
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix-queue" }));
    const workspaceStore = storeOver({ createWorktree });
    workspaceStore.bind(actionsWith());
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: true, workspace: REPO });
    workspaceStore.registerWorktreeNamer(async ({ description }) => description.includes("queue") ? "fix/queue" : "");
    workspaceStore.setWorkspaceMode("worktree");

    const preparing: string[] = [];
    await expect(workspaceStore.prepareThreadWorktree({
      prompt: "Steer queued messages into the running turn",
      preparing: (message) => preparing.push(message),
    })).resolves.toEqual({ workspace: { workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix-queue" } });
    expect(preparing).toEqual(["Setting up worktree…"]);
    expect(createWorktree).toHaveBeenCalledWith("fix/queue", { startFromOrigin: true }, "ws1_project");
    expect(workspaceStore.getSnapshot().preparingWorktree).toBe(false);
  });

  it("stays in the checkout when the mode is current, and when creation fails", async () => {
    const createWorktree = vi.fn(async () => { throw new Error("origin is unreachable"); });
    const notify = vi.fn();
    const workspaceStore = storeOver({ createWorktree });
    workspaceStore.bind(actionsWith({ notify }));
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: true, workspace: REPO });

    const event = { prompt: "do the thing", preparing: () => undefined };
    await expect(workspaceStore.prepareThreadWorktree(event)).resolves.toEqual({});
    expect(createWorktree).not.toHaveBeenCalled();

    workspaceStore.setWorkspaceMode("worktree");
    await expect(workspaceStore.prepareThreadWorktree(event)).resolves.toEqual({});
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("this thread runs in the checkout"));
    // The name is the fallback one; no naming extension is registered here.
    expect(createWorktree.mock.calls[0]?.[0]).toMatch(/^tau\/[0-9a-f]{8}$/u);
  });

  it("takes the mode from the project, then from the checked-in default, then from the global one", async () => {
    const preferences = new PreferencesStore();
    const workspaceStore = storeOver({ getProjectDefaults: async () => ({ workspaceMode: "worktree" }) }, preferences);
    workspaceStore.bind(actionsWith());
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    await vi.waitFor(() => expect(workspaceStore.workspaceMode()).toBe("worktree"));

    // The user's own choice for this project beats the file.
    workspaceStore.setWorkspaceMode("current");
    expect(workspaceStore.workspaceMode()).toBe("current");
    // A thread that exists has no choice left to make.
    workspaceStore.update({ draftPending: false });
    expect(workspaceStore.workspaceMode()).toBe("current");
  });
});
