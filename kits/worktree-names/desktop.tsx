import type { DesktopExtension, PreferencesStore } from "tau";
import { WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "../workspace/protocol.js";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

const MODEL_OPTION = "model";

/** A vendor's small tier by its id: `claude-haiku-4-5`, `gpt-5-mini`, `gemini-2.5-flash`, `gpt-5.6-luna`. */
const SMALL_MODEL = /(?:^|[-_./:])(?:haiku|mini|nano|flash|lite|luna|small|tiny)(?=$|[-_./:\d])/iu;

export function isSmallModel(id: string): boolean {
  return SMALL_MODEL.test(id);
}

/**
 * The model the settings chose; else the draft's (or thread's) own when it is
 * a small Pi model; else none, and the host takes the default model of the
 * user's Pi configuration, as it does for titles. A branch name is three
 * words, never worth a large model the user picked for the work itself, and
 * another runtime's model would be billed through Pi's providers instead.
 */
export function namingModel(
  thread: { model?: { provider: string; id: string }; backendKind?: string } | undefined,
  preferences: PreferencesStore,
): { provider: string; id: string } | undefined {
  const stored = preferences.value(WORKTREE_NAMES_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  if (at > 0 && at < stored.length - 1) return { provider: stored.slice(0, at), id: stored.slice(at + 1) };
  const model = thread?.model;
  const onPi = (thread?.backendKind ?? "pi") === "pi";
  return model && onPi && isSmallModel(model.id) ? { provider: model.provider, id: model.id } : undefined;
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
        const model = namingModel(actions.activeThread(), context.preferences);
        const result = await context.host.invoke("suggest", { provider: model?.provider, modelId: model?.id, description, hint, taken }) as { branch: string };
        return result.branch;
      }));
  },
};

export default worktreeNamesExtension;
