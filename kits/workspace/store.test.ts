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
  it("rereads a different home workspace even when the displayed host path is identical", async () => {
    const getWorkspaceInfo = vi.fn(async () => REPO);
    const getChanges = vi.fn(async () => ({ isRepo: true, files: [] }));
    const workspaceStore = storeOver({ getWorkspaceInfo, getChanges });
    workspaceStore.follow({ cwd: "/home/dev/repo", workspaceId: "ws1_rex", sessionId: "rex~one", draftPending: false });
    await vi.waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalledWith("ws1_rex"));
    workspaceStore.follow({ cwd: "/home/dev/repo", workspaceId: "ws1_other", sessionId: "other~one", draftPending: false });
    await vi.waitFor(() => expect(getWorkspaceInfo).toHaveBeenLastCalledWith("ws1_other"));
    expect(getChanges).toHaveBeenLastCalledWith(undefined, "ws1_other");
  });

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

  it("pins sibling worktrees to the first resolved commit in the draft project", async () => {
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_child", displayPath: "/worktrees/child", baseCommit: "abc123" }));
    const workspaceStore = storeOver({ createWorktree });
    workspaceStore.bind(actionsWith());
    workspaceStore.update({ cwd: "/project", workspaceId: "ws1_project", draftPending: true, workspace: REPO });
    workspaceStore.registerWorktreeNamer(async () => "fix/task");
    const first = await workspaceStore.prepareThreadWorktree({ prompt: "do it", preparing: () => undefined, force: true });
    expect(first.baseCommit).toBe("abc123");
    await workspaceStore.prepareThreadWorktree({ prompt: "do it", preparing: () => undefined, force: true, branchSuffix: "2", baseCommit: first.baseCommit });
    expect(createWorktree).toHaveBeenLastCalledWith("fix/task-2", { baseRef: "abc123", startFromOrigin: false }, "ws1_project");
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

  it("makes the draft's worktree on the name and base chosen in its Branch section, and forgets them with the draft", async () => {
    const createWorktree = vi.fn(async (branch: string) => ({ workspaceId: `ws1_${branch}`, displayPath: `/project-worktrees/${branch}` }));
    const workspaceStore = storeOver({ createWorktree });
    workspaceStore.bind(actionsWith());
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    workspaceStore.update({ workspace: REPO });
    workspaceStore.setWorkspaceMode("worktree");
    workspaceStore.setDraftBranch({ name: "  feat/pages  ", base: "origin/release" });
    expect(workspaceStore.getSnapshot()).toMatchObject({ draftBranch: "feat/pages", draftBase: "origin/release" });

    await workspaceStore.prepareThreadWorktree({ prompt: "add paging", preparing: () => undefined });
    expect(createWorktree).toHaveBeenCalledWith("feat/pages", expect.objectContaining({ baseRef: "origin/release" }), "ws1_project");

    // An emptied name goes back to automatic naming.
    workspaceStore.setDraftBranch({ name: "" });
    expect(workspaceStore.getSnapshot().draftBranch).toBeUndefined();
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "started", draftPending: false });
    expect(workspaceStore.getSnapshot()).toMatchObject({ draftBranch: undefined, draftBase: undefined });
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

describe("Workspace Kit's default for a new draft", () => {
  it("applies a changed global default to the next draft and to the open one, at once", () => {
    const preferences = new PreferencesStore();
    const workspaceStore = storeOver({}, preferences);
    workspaceStore.bind({ holdComposer: () => () => undefined, openWorkspace: vi.fn(async () => true), notify: vi.fn() } as unknown as WorkbenchActions);
    const stop = workspaceStore.followDefaultChanges();
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "first", draftPending: false });
    preferences.setValue("tau.workspace", "new-thread-workspace", "worktree");
    // A new draft in the same project: no project change to wait for.
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    expect(workspaceStore.workspaceMode()).toBe("worktree");
    // The setting changed while the draft is open.
    preferences.setValue("tau.workspace", "new-thread-workspace", "current");
    expect(workspaceStore.workspaceMode()).toBe("current");
    stop();
    preferences.setValue("tau.workspace", "new-thread-workspace", "worktree");
    expect(workspaceStore.workspaceMode()).toBe("current");
  });
});

describe("Workspace Kit's worktree suggestion (K125)", () => {
  const actions = () => ({ holdComposer: () => () => undefined, openWorkspace: vi.fn(async () => true), notify: vi.fn() } as unknown as WorkbenchActions);
  const draftIn = async (overrides: WorkspaceHostStubOverrides = {}, preferences = new PreferencesStore()) => {
    const workspaceStore = storeOver({ getWorkspaceInfo: async () => REPO, ...overrides }, preferences);
    workspaceStore.bind(actions());
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().workspace).toBeDefined());
    return workspaceStore;
  };

  it("preselects a worktree only while another turn runs in the draft's folder, and never as the project's default", async () => {
    const preferences = new PreferencesStore();
    const workspaceStore = await draftIn({}, preferences);
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBeFalsy();
    expect(workspaceStore.workspaceMode()).toBe("current");

    workspaceStore.followBusyCheckout(true);
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBe(true);
    expect(workspaceStore.workspaceMode()).toBe("worktree");
    expect(preferences.value("tau.workspace", "workspace-mode:/project")).toBeUndefined();

    // Turned off, it stays off: the other turn ending and a new one starting change nothing.
    workspaceStore.setWorktreeSuggestion(false);
    workspaceStore.followBusyCheckout(false);
    workspaceStore.followBusyCheckout(true);
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBe(true);
    expect(workspaceStore.workspaceMode()).toBe("current");
    expect(preferences.value("tau.workspace", "workspace-mode:/project")).toBeUndefined();

    // The next draft of the project starts from its default and is asked again.
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "started", draftPending: false });
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBe(false);
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBe(true);
    expect(workspaceStore.workspaceMode()).toBe("worktree");
  });

  it("keeps the suggestion on screen when the other turn ends before the prompt is sent", async () => {
    const workspaceStore = await draftIn();
    workspaceStore.followBusyCheckout(true);
    workspaceStore.followBusyCheckout(false);
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBe(true);
    expect(workspaceStore.workspaceMode()).toBe("worktree");
  });

  it("suggests nothing for a folder that is no repository, or a draft that already runs in a worktree", async () => {
    const plain = await draftIn({ getWorkspaceInfo: async () => ({ ...REPO, isRepo: false }) });
    plain.followBusyCheckout(true);
    expect(plain.getSnapshot().worktreeSuggested).toBeFalsy();

    const workspaceStore = await draftIn();
    workspaceStore.setWorkspaceMode("worktree");
    workspaceStore.followBusyCheckout(true);
    expect(workspaceStore.getSnapshot().worktreeSuggested).toBeFalsy();
  });

  it("sends the suggested worktree down the thread-worktree path", async () => {
    const createWorktree = vi.fn(async () => ({ workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix" }));
    const workspaceStore = await draftIn({ createWorktree });
    workspaceStore.followBusyCheckout(true);
    await expect(workspaceStore.prepareThreadWorktree({ prompt: "fix", preparing: () => undefined }))
      .resolves.toEqual({ workspace: { workspaceId: "ws1_worktree", displayPath: "/project-worktrees/fix" } });
    expect(createWorktree).toHaveBeenCalledWith(expect.stringMatching(/^tau\/[0-9a-f]{8}$/u), { startFromOrigin: true }, "ws1_project");
  });

  it("says a turn was not recorded only for a thread that stayed in the checkout on purpose", async () => {
    const workspaceStore = await draftIn({ createWorktree: async () => { throw new Error("disk full"); } });
    workspaceStore.followBusyCheckout(true);
    await workspaceStore.prepareThreadWorktree({ prompt: "fix", preparing: () => undefined });
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "fell-back", draftPending: false });
    // Its worktree failed, which the user was told; it did not choose the checkout.
    expect(workspaceStore.skippedCheckpointNotice("fell-back")).toBeUndefined();

    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", draftPending: true });
    workspaceStore.setWorktreeSuggestion(false);
    await workspaceStore.prepareThreadWorktree({ prompt: "fix", preparing: () => undefined });
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "stayed", draftPending: false });
    expect(workspaceStore.skippedCheckpointNotice("stayed")).toBe(
      "Turn changes were not recorded: another turn is active in this workspace. Start the next thread in its own worktree to keep changes separate.",
    );
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

describe("Workspace Kit branch after a checkout outside Tau", () => {
  it("rereads the branch when the shown thread's turn ends and when the host sees HEAD move", async () => {
    let branch = "main";
    const getWorkspaceInfo = vi.fn(async () => ({ ...REPO, branch }));
    const workspaceStore = storeOver({ getWorkspaceInfo });
    workspaceStore.follow({ cwd: "/project", workspaceId: "ws1_project", sessionId: "shown", draftPending: false });
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().workspace?.branch).toBe("main"));

    branch = "feature";
    workspaceStore.turnSettled("shown");
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().workspace?.branch).toBe("feature"));

    branch = "other";
    getWorkspaceInfo.mockClear();
    workspaceStore.headChanged("/elsewhere");
    workspaceStore.turnSettled("background");
    expect(getWorkspaceInfo).not.toHaveBeenCalled();
    workspaceStore.headChanged("/project");
    await vi.waitFor(() => expect(workspaceStore.getSnapshot().workspace?.branch).toBe("other"));
  });
});

describe("Workspace Kit's Changes entry", () => {
  it("opens the Diff stage while a kit draws it, and leaves the panel to open otherwise", () => {
    const workspaceStore = storeOver({});
    const actions = { openOverlay: vi.fn(), openPanel: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);

    expect(workspaceStore.openChangesView()).toBe(false);
    expect(actions.openOverlay).not.toHaveBeenCalled();

    const release = workspaceStore.registerReviewView();
    expect(workspaceStore.openChangesView()).toBe(true);
    expect(actions.openPanel).toHaveBeenCalledWith("review.diff");
    expect(actions.openOverlay).not.toHaveBeenCalled();
    expect(workspaceStore.getSnapshot().review).toBeUndefined();

    release();
    release();
    expect(workspaceStore.openChangesView()).toBe(false);
  });
});
