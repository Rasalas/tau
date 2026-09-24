import { errorMessage, type DesktopExtension, type HostExtensionClient, type PreferencesStore, type PromptSubmittedEvent, type WorkbenchActions } from "tau";
import { THREAD_TITLES_HOST_EXTENSION_ID, THREAD_TITLES_SERVICE, type ThreadTitlesService } from "./protocol.js";

const MODEL_OPTION = "model";

function automatic(preferences: PreferencesStore): boolean {
  return preferences.optionValue(THREAD_TITLES_HOST_EXTENSION_ID, "automatic", true);
}

/** The model chosen in the settings; without one the host picks a small model. */
export function titleModel(preferences: PreferencesStore): { provider: string; id: string } | undefined {
  const stored = preferences.value(THREAD_TITLES_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  return at > 0 && at < stored.length - 1 ? { provider: stored.slice(0, at), id: stored.slice(at + 1) } : undefined;
}

/** The thread's model, whatever its runtime: the host's hint for a small model close to it, never the model that titles. */
export function threadModel(thread: { model?: { provider: string; id: string } } | undefined): { provider: string; id: string } | undefined {
  const model = thread?.model;
  return model ? { provider: model.provider, id: model.id } : undefined;
}

/**
 * The host entry renames the thread; the new title arrives like any other
 * rename. An automatic title is made from the submitted prompt right away,
 * not after the run ends.
 */
async function generate(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  preferences: PreferencesStore,
  thread: { model?: { provider: string; id: string }; sessionId?: string } | undefined,
  force: boolean,
  prompt?: string,
): Promise<void> {
  const model = titleModel(preferences);
  const prefer = model ? undefined : threadModel(thread);
  try {
    // Two commands, so the host tells a title the user asked for from one that followed a prompt.
    await host.invoke(force ? "regenerate" : "generate", { provider: model?.provider, modelId: model?.id, ...(prefer ? { prefer } : {}), force, sessionId: thread?.sessionId, prompt });
  } catch (error) {
    actions.notify(errorMessage(error));
  }
}

/** Whether this prompt is the one that should name its thread. */
export function shouldTitleAutomatically(event: PromptSubmittedEvent, preferences: PreferencesStore): boolean {
  const snapshot = event.snapshot;
  if (!automatic(preferences) || !snapshot) return false;
  return !snapshot.messages.some((message) => message.role === "user");
}

export const titleGeneratorExtension: DesktopExtension = {
  id: THREAD_TITLES_HOST_EXTENSION_ID,
  name: "Title generator",
  activate(context) {
    context.registerOptions([
      { id: "automatic", kind: "toggle", label: "Name a thread after its first prompt", defaultValue: true },
      { id: MODEL_OPTION, kind: "model", label: "Model that names threads" },
    ]);
    context.provideService<ThreadTitlesService>(THREAD_TITLES_SERVICE, {
      regenerate: (actions) => generate(context.host, actions, context.preferences, actions.activeThread(), true),
    });
    context.registerCommand({
      id: "thread-titles.regenerate",
      label: "Regenerate title",
      group: "Thread",
      access: "write",
      surfaces: ["thread-title"],
      run: async (actions) => {
        await generate(context.host, actions, context.preferences, actions.activeThread(), true);
      },
    });
    context.registerPromptHook({
      id: "thread-titles.auto-generate",
      async afterPrompt(event, actions) {
        if (!shouldTitleAutomatically(event, context.preferences)) return;
        await generate(context.host, actions, context.preferences, event.snapshot, false, event.prompt);
      },
    });
  },
};

export default titleGeneratorExtension;
