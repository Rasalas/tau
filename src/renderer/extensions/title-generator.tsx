import type { DesktopExtension, WorkbenchActions } from "../extension-system";
import { preferences } from "../preferences";

const EXTENSION_ID = "tau.thread-titles";

function automatic(): boolean {
  return preferences.optionValue(EXTENSION_ID, "automatic", true);
}

/**
 * Titles are generated with the thread's own model, so there is nothing to
 * configure beyond whether it happens on its own.
 */
async function generate(actions: WorkbenchActions, provider: string, modelId: string, force: boolean): Promise<void> {
  await actions.generateThreadTitle(provider, modelId, force);
}

export const titleGeneratorExtension: DesktopExtension = {
  id: EXTENSION_ID,
  name: "Title generator",
  activate(context) {
    context.registerOptions([
      { id: "automatic", kind: "toggle", label: "Name a thread after its first completed prompt", defaultValue: true },
    ]);
    context.registerCommand({
      id: "thread-titles.regenerate",
      label: "Rename this thread",
      group: "Thread",
      run: async (actions) => { await actions.regenerateTitle(true); },
    });
    context.registerPromptHook({
      id: "thread-titles.auto-generate",
      async afterPrompt(event, actions) {
        const model = event.snapshot?.model;
        if (!automatic() || !model) return;
        await generate(actions, model.provider, model.id, false);
      },
    });
  },
};
