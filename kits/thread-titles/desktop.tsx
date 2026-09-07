import { errorMessage, type DesktopExtension, type HostExtensionClient, type PreferencesStore, type PromptSubmittedEvent, type WorkbenchActions } from "tau";
import { THREAD_TITLES_HOST_EXTENSION_ID } from "./protocol.js";

const MODEL_OPTION = "model";

function automatic(preferences: PreferencesStore): boolean {
  return preferences.optionValue(THREAD_TITLES_HOST_EXTENSION_ID, "automatic", true);
}

/**
 * Which model writes the title: the one chosen in the settings, else the
 * thread's own where that means anything — a model id belongs to the runtime
 * that reported it, and only Pi's is the one titles are completed on. With
 * neither, the host uses the default model from the user's Pi configuration,
 * so a thread of any runtime still gets a name.
 */
export function titleModel(
  thread: { model?: { provider: string; id: string }; backendKind?: string } | undefined,
  preferences: PreferencesStore,
): { provider: string; id: string } | undefined {
  const stored = preferences.value(THREAD_TITLES_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  if (at > 0 && at < stored.length - 1) return { provider: stored.slice(0, at), id: stored.slice(at + 1) };
  const ownedByPi = thread?.backendKind === undefined || thread.backendKind === "pi";
  return ownedByPi ? thread?.model : undefined;
}

/**
 * The host entry renames the thread; the new title arrives like any other
 * rename. An automatic title is made from the submitted prompt right away,
 * not after the run ends.
 */
async function generate(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  model: { provider: string; id: string } | undefined,
  sessionId: string | undefined,
  force: boolean,
  prompt?: string,
): Promise<void> {
  try {
    await host.invoke("generate", { provider: model?.provider, modelId: model?.id, force, sessionId, prompt });
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
    context.registerCommand({
      id: "thread-titles.regenerate",
      label: "Regenerate title",
      group: "Thread",
      surfaces: ["thread-title"],
      run: async (actions) => {
        const thread = actions.activeThread();
        await generate(context.host, actions, titleModel(thread, context.preferences), thread?.sessionId, true);
      },
    });
    context.registerPromptHook({
      id: "thread-titles.auto-generate",
      async afterPrompt(event, actions) {
        if (!shouldTitleAutomatically(event, context.preferences)) return;
        await generate(context.host, actions, titleModel(event.snapshot, context.preferences), event.snapshot?.sessionId, false, event.prompt);
      },
    });
  },
};

export default titleGeneratorExtension;
