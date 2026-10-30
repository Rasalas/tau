import { errorMessage, type DesktopExtension, type HostExtensionClient, type PreferencesStore, type PromptSubmittedEvent, type WorkbenchActions } from "tau";
import { textChoice, textChoiceInput } from "../_shared/text-generation.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, THREAD_TITLES_SERVICE, TITLE_FAILED_EVENT, type ThreadTitlesService } from "./protocol.js";

function automatic(preferences: PreferencesStore): boolean {
  return preferences.optionValue(THREAD_TITLES_HOST_EXTENSION_ID, "automatic", true);
}

/**
 * The model Text generation names for titles (Review's page: the titles' own,
 * else the default; this kit's own option from before until then); without one
 * the host picks a small model.
 */
export function titleModel(preferences: PreferencesStore): { provider: string; id: string } | undefined {
  return textChoice(preferences, "title")?.model;
}

/** What the host command reads for a title: the model, its effort and the runtime that writes it. */
function titleRequest(preferences: PreferencesStore) {
  const choice = textChoice(preferences, "title");
  return { provider: choice?.model?.provider, modelId: choice?.model?.id, ...textChoiceInput(choice) };
}

/** The thread's model, whatever its runtime: the host's hint for a small model close to it, never the model that titles. */
export function threadModel(thread: { model?: { provider: string; id: string } } | undefined): { provider: string; id: string } | undefined {
  const model = thread?.model;
  return model ? { provider: model.provider, id: model.id } : undefined;
}

/**
 * The host entry renames the thread; the new title arrives like any other
 * rename. The host can wait for a harness's native title and first answer.
 */
async function generate(
  host: HostExtensionClient,
  actions: WorkbenchActions,
  preferences: PreferencesStore,
  thread: { model?: { provider: string; id: string }; sessionId?: string } | undefined,
  force: boolean,
  prompt?: string,
): Promise<void> {
  const request = titleRequest(preferences);
  const prefer = request.provider ? undefined : threadModel(thread);
  try {
    // Two commands, so the host tells a title the user asked for from one that followed a prompt.
    await host.invoke(force ? "regenerate" : "generate", { ...request, ...(prefer ? { prefer } : {}), force, sessionId: thread?.sessionId, prompt });
  } catch (error) {
    actions.notify(errorMessage(error), "error");
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
    let promptActions: WorkbenchActions | undefined;
    context.host.onEvent(TITLE_FAILED_EVENT, (payload) => {
      const message = (payload as { message?: unknown } | undefined)?.message;
      promptActions?.notify(`Could not name the thread: ${typeof message === "string" ? message : "Title generation failed."}`, "error");
    });
    // The model that names threads is chosen with commit messages' and descriptions' under Extensions → Review.
    context.registerOptions([
      { id: "automatic", kind: "toggle", label: "Name a thread after its first prompt", defaultValue: true },
    ]);
    context.provideService<ThreadTitlesService>(THREAD_TITLES_SERVICE, {
      regenerate: (actions) => generate(context.host, actions, context.preferences, actions.activeThread(), true),
      // The host knows each thread's own model, so only the settings' choice goes along.
      regenerateThread: async (sessionId) => {
        await context.host.invoke("regenerate", { ...titleRequest(context.preferences), force: true, sessionId });
      },
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
      async afterPrompt(event, nextActions) {
        promptActions = nextActions;
        if (!shouldTitleAutomatically(event, context.preferences)) return;
        await generate(context.host, nextActions, context.preferences, event.snapshot, false, event.prompt);
      },
    });
  },
};

export default titleGeneratorExtension;
