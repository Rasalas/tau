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

  it("hands the submodule setting to the host only when it names a value", async () => {
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/project-worktrees/x" }));
    const preferences = new PreferencesStore();
    const workspaceStore = storeOver({ createWorktree }, preferences);
    workspaceStore.bind({ holdComposer: () => () => undefined, openWorkspace: async () => true, notify: vi.fn() } as unknown as WorkbenchActions);
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });

    await workspaceStore.createWorktree("x");
    preferences.setValue("tau.workspace", "worktree-submodules", "top-level");
    await workspaceStore.createWorktree("y");

    expect(createWorktree).toHaveBeenNthCalledWith(1, "x", { startFromOrigin: true }, "ws1_project");
    expect(createWorktree).toHaveBeenNthCalledWith(2, "y", { startFromOrigin: true, submodules: "top-level" }, "ws1_project");
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

describe("Workspace Kit publishing", () => {
  it("refreshes changes and branch status after pulling", async () => {
    const pull = vi.fn(async () => ({ detail: "Pulled def456" }));
    const changes = { files: [], added: 0, removed: 0 };
    const workspace = { ...REPO, upstream: "origin/main", behind: 0 };
    const workspaceStore = storeOver({ pull, getChanges: async () => changes, getWorkspaceInfo: async () => workspace });
    const notify = vi.fn();
    workspaceStore.bind({ notify } as unknown as WorkbenchActions);
    workspaceStore.update({ cwd: "/project", draftPending: false, workspace: { ...REPO, upstream: "origin/main", behind: 2 } });

    await workspaceStore.pull();

    expect(pull).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("Pulled def456");
    expect(workspaceStore.getSnapshot()).toMatchObject({ changes, workspace, committing: false });
  });
});

describe("Workspace Kit automatic pull", () => {
  it("asks nothing while the option is off, and refreshes after a pull once it is on", async () => {
    const autoPull = vi.fn(async () => [{ checkout: "workspace", status: "pulled", branch: "main", upstream: "origin/main", commits: 2, head: "abc" }]);
    const getWorkspaceInfo = vi.fn(async () => REPO);
    const preferences = new PreferencesStore();
    const workspaceStore = storeOver({ autoPull, getWorkspaceInfo }, preferences);
    workspaceStore.bind({ notify: vi.fn() } as unknown as WorkbenchActions);
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: false });

    await workspaceStore.autoPullDefaultBranch();
    expect(autoPull).not.toHaveBeenCalled();

    preferences.setOption("tau.workspace", "auto-pull-default-branch", true);
    await workspaceStore.autoPullDefaultBranch();
    expect(autoPull).toHaveBeenCalledWith("ws1_project");
    expect(getWorkspaceInfo).toHaveBeenCalled();
  });

  it("leaves the view alone when nothing was pulled", async () => {
    const autoPull = vi.fn(async () => [{ checkout: "workspace", status: "skipped", reason: "dirty" }]);
    const getChanges = vi.fn(async () => ({ files: [], added: 0, removed: 0 }));
    const preferences = new PreferencesStore();
    preferences.setOption("tau.workspace", "auto-pull-default-branch", true);
    const workspaceStore = storeOver({ autoPull, getChanges }, preferences);
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: false });
    await workspaceStore.autoPullDefaultBranch();
    expect(autoPull).toHaveBeenCalledOnce();
    expect(getChanges).not.toHaveBeenCalled();
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
    const createWorktree = vi.fn(async (branch: string) => { throw new Error(`origin is unreachable for ${branch}`); });
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

  it("makes a worktree on request in the current mode, with a suffix so one prompt can have several", async () => {
    const createWorktree = vi.fn(async (branch: string) => ({ workspaceId: `ws1_${branch}`, displayPath: `/project-worktrees/${branch}` }));
    const workspaceStore = storeOver({ createWorktree });
    workspaceStore.bind(actionsWith());
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: true, workspace: REPO });
    workspaceStore.registerWorktreeNamer(async () => "fix/queue");

    const request = { prompt: "fix the queue", preparing: () => undefined, force: true };
    await workspaceStore.prepareThreadWorktree({ ...request, branchSuffix: "1" });
    await workspaceStore.prepareThreadWorktree({ ...request, branchSuffix: "2" });
    expect(createWorktree.mock.calls.map((call) => call[0])).toEqual(["fix/queue-1", "fix/queue-2"]);

    workspaceStore.update({ workspace: { ...REPO, isRepo: false } });
    await expect(workspaceStore.prepareThreadWorktree(request)).resolves.toEqual({});
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

describe("Workspace Kit files of the followed project", () => {
  it("lists a draft's project, which need not be the one the host has open", async () => {
    const getFileTree = vi.fn(async (relPath?: string) => [{ name: "only-in-b.ts", path: relPath ? `${relPath}/only-in-b.ts` : "only-in-b.ts", kind: "file" }]);
    const workspaceStore = storeOver({ getFileTree });
    workspaceStore.follow({ cwd: "/project-b", workspaceId: "ws1_project-b", draftPending: false });

    await workspaceStore.refreshFiles();
    await workspaceStore.loadFiles("src");

    expect(getFileTree).toHaveBeenCalledWith(undefined, "ws1_project-b");
    expect(getFileTree).toHaveBeenCalledWith("src", "ws1_project-b");
  });
});

describe("Workspace Kit changes of the project on screen", () => {
  it("lists a draft's project's changes, not those of the project the host has open", async () => {
    const changed = (path: string) => ({ files: [{ path, status: "modified", staged: false, added: 1, removed: 1 }], added: 1, removed: 1 });
    const getChanges = vi.fn(async (_query?: unknown, workspace?: string) => changed(workspace === "ws1_project-b" ? "src/b.ts" : "src/a.ts"));
    const workspaceStore = storeOver({ getChanges });
    workspaceStore.follow({ cwd: "/project-a", workspaceId: "ws1_project-a", sessionId: "thread-a", draftPending: false });
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().changes.files.map((file) => file.path)).toEqual(["src/a.ts"]));

    workspaceStore.follow({ cwd: "/project-b", workspaceId: "ws1_project-b", draftPending: true });
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().changes.files.map((file) => file.path)).toEqual(["src/b.ts"]));
    expect(getChanges).toHaveBeenLastCalledWith(undefined, "ws1_project-b");
  });
});

describe("Workspace Kit changes after a turn", () => {
  it("rereads the changes when another thread's turn ends, whose tools this client is not sent", async () => {
    const getChanges = vi.fn(async () => ({ files: [], additions: 0, deletions: 0 }));
    const workspaceStore = storeOver({ getChanges });
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "shown", draftPending: false });
    await vi.waitFor(() => expect(getChanges).toHaveBeenCalled());
    getChanges.mockClear();
    workspaceStore.turnSettled("background");
    await vi.waitFor(() => expect(getChanges).toHaveBeenCalledTimes(1));
    expect(workspaceStore.getSnapshot().turnSettled).toBe(false);
  });
});

describe("Workspace Kit's Changes entry", () => {
  it("opens the review while a kit draws it, and leaves the panel to open otherwise", () => {
    const workspaceStore = storeOver({});
    const actions = { openOverlay: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);

    expect(workspaceStore.openChangesView()).toBe(false);
    expect(actions.openOverlay).not.toHaveBeenCalled();

    const release = workspaceStore.registerReviewView();
    expect(workspaceStore.openChangesView()).toBe(true);
    expect(actions.openOverlay).toHaveBeenCalledTimes(1);
    expect(workspaceStore.getSnapshot().review).toBeDefined();

    release();
    release();
    expect(workspaceStore.openChangesView()).toBe(false);
  });
});
