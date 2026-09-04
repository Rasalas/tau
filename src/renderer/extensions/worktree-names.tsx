import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "../../shared/worktree-names-protocol";
import type { DesktopExtension } from "../extension-system";
import type { PreferencesStore } from "../preferences";

const MODEL_OPTION = "model";

/** The model the settings chose, else the visible thread's own. */
export function namingModel(threadModel: { provider: string; id: string } | undefined, preferences: PreferencesStore): { provider: string; id: string } | undefined {
  const stored = preferences.value(WORKTREE_NAMES_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  if (at > 0 && at < stored.length - 1) return { provider: stored.slice(0, at), id: stored.slice(at + 1) };
  return threadModel;
}

/**
 * Names a new worktree after the task in the composer. Workspace Kit shows
 * the offer only while this extension is active; without it, worktrees are
 * named by hand.
 */
export const worktreeNamesExtension: DesktopExtension = {
  id: WORKTREE_NAMES_HOST_EXTENSION_ID,
  name: "Worktree Names",
  activate(context) {
    context.registerOptions([
      { id: MODEL_OPTION, kind: "model", label: "Model that names new worktrees" },
    ]);
    return context.workspaceStore.registerWorktreeNamer(async ({ hint, description, taken, actions }) => {
      const model = namingModel(actions.activeThread()?.model, context.preferences);
      if (!model) throw new Error("No model is selected for naming worktrees.");
      const result = await context.host.invoke("suggest", { provider: model.provider, modelId: model.id, description, hint, taken }) as { branch: string };
      return result.branch;
    });
  },
};
