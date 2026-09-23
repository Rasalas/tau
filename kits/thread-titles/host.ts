import { buildTitleConversation, cleanThreadTitle, smallCompletionModel, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_SYSTEM_PROMPT, TITLE_USER_PROMPT } from "./protocol.js";

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * Thread Title Generator's host entry. It titles a thread with the model the
 * settings name, else a small one; renaming itself stays a core action.
 */
export function createThreadTitlesHostExtension(): HostExtension {
  return {
    id: THREAD_TITLES_HOST_EXTENSION_ID,
    name: "Thread Title Generator",
    permissions: ["sessions"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      context.registerCommand("generate", async (input) => {
        const fields = record(input);
        // The settings' model wins; else a small one close to the thread's (`prefer`), never the thread's own.
        const provider = text(fields.provider);
        const modelId = text(fields.modelId);
        const preferred = record(fields.prefer);
        const prefer = text(preferred.provider) && text(preferred.id) ? { provider: text(preferred.provider), id: text(preferred.id) } : undefined;
        const chooseModel = async (hint = prefer) => provider && modelId ? { provider, id: modelId } : smallCompletionModel(services, hint);
        const force = fields.force === true;
        const sessionId = typeof fields.sessionId === "string" ? fields.sessionId : undefined;
        const prompt = typeof fields.prompt === "string" ? fields.prompt : "";
        if (services.runtimeOwner() === "pi") {
          const attached = services.attachedRuntime(sessionId);
          if (!attached) throw new Error("The attached Pi runtime is not ready.");
          // The attached Pi completes on its own registry, which has no default to fall back to.
          const chosen = await chooseModel() ?? prefer;
          if (!chosen) throw new Error("Title generation needs a model while Pi is attached to the runtime.");
          return attached.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", { provider: chosen.provider, modelId: chosen.id, force });
        }
        const thread = services.thread(sessionId);
        if (!thread) {
          throw new Error(sessionId ? "That thread is not open any more. Open it again to continue." : "Pi runtime is not ready");
        }
        if (force && thread.isStreaming()) throw new Error("Wait for the active agent run before generating a title.");
        if (thread.sessionName() && !force) return undefined;
        // An automatic title must not wait for the run: agentic first turns take
        // minutes, and the prompt alone names the thread well enough. The
        // prompt stands in while the transcript has not persisted it yet.
        const conversation = buildTitleConversation(
          (await thread.transcript()).map((message) => ({ role: message.role, content: message.text })),
          [{ role: "user", content: prompt }],
        );
        if (!conversation) {
          if (!force) return undefined;
          throw new Error("The thread has no conversation to title yet.");
        }

        // The thread knows its model even where a new thread's draft named none.
        const model = await chooseModel(thread.model ?? prefer);
        services.log("title.started", model ? `${model.provider}/${model.id}` : "default model");
        // Titling runs on the user's own model configuration, whichever runtime owns the thread;
        // without a small model there, on its default.
        const title = cleanThreadTitle(await services.complete({
          system: TITLE_SYSTEM_PROMPT,
          prompt: TITLE_USER_PROMPT(conversation),
          maxTokens: 48,
        }, model));
        if (!thread.isCurrent()) return undefined;
        await services.setThreadTitle(thread.sessionId, title, "generated");
        services.log("title.generated", title);
        return { title };
      });
    },
  };
}

export default createThreadTitlesHostExtension;
