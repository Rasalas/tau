// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness, type KitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient, WORKSPACE_STORE_SERVICE } from "../workspace/protocol.js";
import { WorkspaceStore } from "../workspace/store.js";
import { namingModel, worktreeNamesExtension } from "./desktop.js";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

/** Stands in for Workspace Kit: the store, published under the id both kits name. */
function workspaceProvider(store: WorkspaceStore) {
  return {
    id: "tau.workspace",
    name: "Workspace Kit",
    activate: (context: Parameters<typeof worktreeNamesExtension.activate>[0]) => context.provideService(WORKSPACE_STORE_SERVICE, store),
  };
}

const threadModel = { provider: "anthropic", id: "claude" };

let harness: KitHarness;

beforeEach(() => { harness = createKitHarness(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("naming model", () => {
  it("prefers the model chosen in settings and falls back to the thread's", () => {
    const { preferences } = harness;
    expect(namingModel(threadModel, preferences)).toEqual(threadModel);
    preferences.setValue(WORKTREE_NAMES_HOST_EXTENSION_ID, "model", "openai/gpt-5.6");
    expect(namingModel(threadModel, preferences)).toEqual({ provider: "openai", id: "gpt-5.6" });
    preferences.setValue(WORKTREE_NAMES_HOST_EXTENSION_ID, "model", "");
    expect(namingModel(undefined, preferences)).toBeUndefined();
  });
});

describe("Worktree Names desktop extension", () => {
  it("offers naming to Workspace Kit while active and asks the host with the task", async () => {
    const invoke = vi.fn(async () => ({ branch: "fix/steer-queue-messages" }));
    const { registry } = createKitHarness(invoke);
    const workspaceStore = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient(async () => undefined));
    registry.activate(workspaceProvider(workspaceStore));
    const notify = vi.fn();
    const actions = {
      notify,
      composerDraft: () => "Steer queued messages into the running turn",
      activeThread: () => ({ model: threadModel, draftPending: true }),
    } as unknown as WorkbenchActions;
    workspaceStore.bind(actions);
    workspaceStore.update({ workspace: { root: "/project", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [{ name: "main", isCurrent: true }], worktreeParent: "/worktrees" } });

    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(false);
    registry.activate(worktreeNamesExtension);
    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(true);
    expect(registry.getExtensionSummaries().find((summary) => summary.id === WORKTREE_NAMES_HOST_EXTENSION_ID)?.options).toEqual([
      { id: "model", kind: "model", label: "Model that names new worktrees" },
    ]);

    await expect(workspaceStore.suggestWorktreeName("fix")).resolves.toBe("fix/steer-queue-messages");
    expect(invoke).toHaveBeenCalledWith(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", {
      provider: "anthropic", modelId: "claude", description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });

    invoke.mockRejectedValueOnce(new Error("The model did not answer with a usable branch name."));
    await expect(workspaceStore.suggestWorktreeName("")).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("The model did not answer with a usable branch name.");

    registry.deactivate(WORKTREE_NAMES_HOST_EXTENSION_ID);
    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(false);
    await expect(workspaceStore.suggestWorktreeName("fix")).resolves.toBeUndefined();
  });
});
