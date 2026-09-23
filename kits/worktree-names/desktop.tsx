import type { DesktopExtension, PreferencesStore } from "tau";
import { WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "../workspace/protocol.js";
import { DESCRIBE_THE_TASK, WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

const MODEL_OPTION = "model";

/** The model chosen in the settings; without one the host picks a small model. */
export function namingModel(preferences: PreferencesStore): { provider: string; id: string } | undefined {
  const stored = preferences.value(WORKTREE_NAMES_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  return at > 0 && at < stored.length - 1 ? { provider: stored.slice(0, at), id: stored.slice(at + 1) } : undefined;
}

/** The draft's model, the host's hint for a small model close to it; never the model that names. */
export function draftModel(thread: { model?: { provider: string; id: string } } | undefined): { provider: string; id: string } | undefined {
  const model = thread?.model;
  return model ? { provider: model.provider, id: model.id } : undefined;
}

/**
 * Names a new worktree after the task in the composer. It fills the offer
 * Workspace Kit publishes, whichever of the two activates first; the picker
 * shows the offer only while this extension is active.
 */
export const worktreeNamesExtension: DesktopExtension = {
  id: WORKTREE_NAMES_HOST_EXTENSION_ID,
  name: "Worktree Names",
  activate(context) {
    context.registerOptions([
      { id: MODEL_OPTION, kind: "model", label: "Model that names new worktrees" },
    ]);
    return context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (workspace) =>
      workspace.registerWorktreeNamer(async ({ hint, description, taken, actions }) => {
        // The store shows this as a notice; no host round trip for an empty ask.
        if (!description.trim() && !hint.trim()) throw new Error(DESCRIBE_THE_TASK);
        const model = namingModel(context.preferences);
        const prefer = model ? undefined : draftModel(actions.activeThread());
        const result = await context.host.invoke("suggest", { provider: model?.provider, modelId: model?.id, ...(prefer ? { prefer } : {}), description, hint, taken }) as { branch: string };
        return result.branch;
      }));
  },
};

export default worktreeNamesExtension;
