import { THREAD_TITLES_HOST_EXTENSION_ID } from "../../shared/thread-titles-protocol";
import type { DesktopExtension, HostExtensionClient, PromptSubmittedEvent, WorkbenchActions } from "../extension-system";
import { preferences } from "../preferences";

function automatic(): boolean {
  return preferences.optionValue(THREAD_TITLES_HOST_EXTENSION_ID, "automatic", true);
}

/**
 * Titles are generated with the thread's own model, so there is nothing to
 * configure beyond whether it happens on its own. The host entry renames the
 * thread; the new title arrives like any other rename. An automatic title is
 * made from the submitted prompt right away, not after the run ends.
 */
async function generate(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  model: { provider: string; id: string },
  sessionId: string | undefined,
  force: boolean,
  prompt?: string,
): Promise<void> {
  try {
    await host.invoke("generate", { provider: model.provider, modelId: model.id, force, sessionId, prompt });
  } catch (error) {
    actions.notify(error instanceof Error ? error.message : String(error));
  }
}

export function automaticTitleModel(event: PromptSubmittedEvent): { provider: string; id: string } | undefined {
  const snapshot = event.snapshot;
  if (!automatic() || !snapshot?.model) return undefined;
  if (snapshot.messages.some((message) => message.role === "user")) return undefined;
  return snapshot.model;
}

export const titleGeneratorExtension: DesktopExtension = {
  id: THREAD_TITLES_HOST_EXTENSION_ID,
  name: "Title generator",
  activate(context) {
    context.registerOptions([
      { id: "automatic", kind: "toggle", label: "Name a thread after its first prompt", defaultValue: true },
    ]);
    context.registerCommand({
      id: "thread-titles.regenerate",
      label: "Regenerate title",
      group: "Thread",
      surfaces: ["thread-title"],
      run: async (actions) => {
        const thread = actions.activeThread();
        if (!thread?.model) { actions.notify("No model is selected for this thread."); return; }
        await generate(context.host, actions, thread.model, thread.sessionId, true);
      },
    });
    context.registerPromptHook({
      id: "thread-titles.auto-generate",
      async afterPrompt(event, actions) {
        const model = automaticTitleModel(event);
        if (!model) return;
        await generate(context.host, actions, model, event.snapshot?.sessionId, false, event.prompt);
      },
    });
  },
};
