// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness, type KitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PreferencesStore } from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient, WORKSPACE_STORE_SERVICE } from "../workspace/protocol.js";
import { WorkspaceStore } from "../workspace/store.js";
import { isSmallModel, namingModel, worktreeNamesExtension } from "./desktop.js";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

/** Stands in for Workspace Kit: the store, published under the id both kits name. */
function workspaceProvider(store: WorkspaceStore) {
  return {
    id: "tau.workspace",
    name: "Workspace Kit",
    activate: (context: Parameters<typeof worktreeNamesExtension.activate>[0]) => context.provideService(WORKSPACE_STORE_SERVICE, store),
  };
}

const threadModel = { provider: "anthropic", id: "claude-haiku-4-5" };

let harness: KitHarness;

beforeEach(() => { harness = createKitHarness(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("naming model", () => {
  it("prefers the model chosen in settings, then a small model of the draft", () => {
    const { preferences } = harness;
    expect(namingModel({ model: threadModel }, preferences)).toEqual(threadModel);
    preferences.setValue(WORKTREE_NAMES_HOST_EXTENSION_ID, "model", "openai/gpt-5.6");
    expect(namingModel({ model: threadModel }, preferences)).toEqual({ provider: "openai", id: "gpt-5.6" });
    preferences.setValue(WORKTREE_NAMES_HOST_EXTENSION_ID, "model", "");
    expect(namingModel(undefined, preferences)).toBeUndefined();
  });

  it("never borrows a large model or one of another runtime; the host's default names the branch then", () => {
    const { preferences } = harness;
    expect(namingModel({ model: { provider: "anthropic", id: "claude-opus-4-1" }, backendKind: "pi" }, preferences)).toBeUndefined();
    // The model a Codex thread reported: small, but not one Pi completes on.
    expect(namingModel({ model: { provider: "openai", id: "gpt-5.6-luna" }, backendKind: "codex" }, preferences)).toBeUndefined();
    expect(namingModel({ model: { provider: "openai", id: "gpt-5.6-sol" }, backendKind: "codex" }, preferences)).toBeUndefined();
    expect(namingModel({ model: { provider: "openai", id: "gpt-5.6-luna" }, backendKind: "pi" }, preferences)).toEqual({ provider: "openai", id: "gpt-5.6-luna" });
  });

  it("knows the small tiers by their ids", () => {
    for (const id of ["claude-haiku-4-5-20251001", "gpt-5-mini", "gpt-4.1-nano", "gemini-2.5-flash", "gemini-2.0-flash-lite", "gpt-5.6-luna", "deepseek-flash", "mistral-small-latest"]) {
      expect(isSmallModel(id), id).toBe(true);
    }
    for (const id of ["claude-opus-4-1", "claude-sonnet-4-5", "gpt-5.6-sol", "gpt-5.6-terra", "gemini-2.5-pro", "minimax-m2", "o3"]) {
      expect(isSmallModel(id), id).toBe(false);
    }
  });
});

describe("Worktree Names desktop extension", () => {
  it("offers naming to Workspace Kit while active and asks the host with the task", async () => {
    const invoke = vi.fn(async () => ({ branch: "fix/steer-queue-messages" }));
    const { registry } = createKitHarness(invoke);
    const workspaceStore = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient(async () => undefined));
    registry.activate(workspaceProvider(workspaceStore));
    const notify = vi.fn();
    let draftModel = threadModel;
    const actions = {
      notify,
      composerDraft: () => "Steer queued messages into the running turn",
      activeThread: () => ({ model: draftModel, backendKind: "pi", draftPending: true }),
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
      provider: "anthropic", modelId: "claude-haiku-4-5", description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });

    // The draft's large model is not borrowed: the host names the branch on the default model.
    draftModel = { provider: "openai", id: "gpt-5.6-sol" };
    await workspaceStore.suggestWorktreeName("fix");
    expect(invoke).toHaveBeenLastCalledWith(WORKTREE_NAMES_HOST_EXTENSION_ID, "suggest", {
      provider: undefined, modelId: undefined, description: "Steer queued messages into the running turn", hint: "fix", taken: ["main"],
    });
    draftModel = threadModel;

    invoke.mockRejectedValueOnce(new Error("The model did not answer with a usable branch name."));
    await expect(workspaceStore.suggestWorktreeName("")).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("The model did not answer with a usable branch name.");

    registry.deactivate(WORKTREE_NAMES_HOST_EXTENSION_ID);
    expect(workspaceStore.getSnapshot().canNameWorktrees).toBe(false);
    await expect(workspaceStore.suggestWorktreeName("fix")).resolves.toBeUndefined();
  });
});
