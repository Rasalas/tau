// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness, type KitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient, WORKSPACE_STORE_SERVICE } from "../workspace/protocol.js";
import { WorkspaceStore } from "../workspace/store.js";
import { draftModel, namingModel, worktreeNamesExtension } from "./desktop.js";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

/** Stands in for Workspace Kit: the store, published under the id both kits name. */
function workspaceProvider(store: WorkspaceStore) {
  return {
    id: "tau.workspace",
    name: "Workspace Kit",
    activate: (context: Parameters<typeof worktreeNamesExtension.activate>[0]) => context.provideService(WORKSPACE_STORE_SERVICE, store),
  };
}

const threadModel = { provider: "openai-codex", id: "gpt-5.6-sol" };

let harness: KitHarness;

beforeEach(() => { harness = createKitHarness(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("naming model", () => {
  it("takes the model chosen in settings, else leaves the choice to the host", () => {
    const { preferences } = harness;
    expect(namingModel(preferences)).toBeUndefined();
    preferences.setValue(WORKTREE_NAMES_HOST_EXTENSION_ID, "model", "openai/gpt-5.6");
    expect(namingModel(preferences)).toEqual({ provider: "openai", id: "gpt-5.6" });
  });

  it("passes the draft's model on as a hint only", () => {
    expect(draftModel({ model: threadModel })).toEqual(threadModel);
    expect(draftModel(undefined)).toBeUndefined();
  });
});

describe("Worktree Names desktop extension", () => {
  it("offers naming to Workspace Kit while active and asks the host with the task", async () => {
    const invoke = vi.fn(async () => ({ branch: "fix/steer-queue-messages" }));
    const { registry } = createKitHarness(invoke);
    const workspaceStore = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient(async () => undefined));
    registry.activate(workspaceProvider(workspaceStore));
    const notify = vi.fn();
    let composerDraft = "Steer queued messages into the running turn";
    const actions = {
      notify,
      composerDraft: () => composerDraft,
      activeThread: () => ({ model: threadModel, backendKind: "pi", draftPending: true }),
    } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);
    workspaceStore.update({ workspace: { root: "/project", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [{ name: "main", isCurrent: true }], worktreeParent: "/worktrees" } });

    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(false);
    registry.activate(worktreeNamesExtension);
    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(true);
    expect(registry.getExtensionSummaries().find((summary) => summary.id === WORKTREE_NAMES_HOST_EXTENSION_ID)?.options).toEqual([
      { id: "model", kind: "model", label: "Model that names new worktrees" },
    ]);

    // The draft's model is only a hint; the host picks the small model that names the branch.
    await expect(workspaceStore.suggestWorktreeName("fix")).resolves.toBe("fix/steer-queue-messages");
    expect(invoke).toHaveBeenCalledWith(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", {
      provider: undefined, modelId: undefined, prefer: threadModel, description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });

    // Nothing to name the branch after: a notice, and the host is not asked.
    composerDraft = "  ";
    invoke.mockClear();
    await expect(workspaceStore.suggestWorktreeName("")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith("Describe the task in the composer first, or type the start of a name.");
    composerDraft = "Steer queued messages into the running turn";

    invoke.mockRejectedValueOnce(new Error("The model did not answer with a usable branch name."));
    await expect(workspaceStore.suggestWorktreeName("")).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("The model did not answer with a usable branch name.");

    registry.deactivate(WORKTREE_NAMES_HOST_EXTENSION_ID);
    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(false);
    await expect(workspaceStore.suggestWorktreeName("fix")).resolves.toBeUndefined();
  });
});
