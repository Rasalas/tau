import { buildTitleConversation, cleanThreadTitle, smallCompletionModel, type HostExtension, type HostExtensionContext, type HostThread } from "tau/host-extension";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_FAILED_EVENT, TITLE_SYSTEM_PROMPT, TITLE_USER_PROMPT } from "./protocol.js";

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
      const pending = new Map<string, { input: unknown; thread: HostThread; running?: boolean }>();
      const generate = async (input: unknown, regenerate: boolean) => {
        const fields = record(input);
        // The settings' model wins; else a small one close to the thread's (`prefer`), the thread's own only when none is small.
        const provider = text(fields.provider);
        const modelId = text(fields.modelId);
        const preferred = record(fields.prefer);
        const prefer = text(preferred.provider) && text(preferred.id) ? { provider: text(preferred.provider), id: text(preferred.id) } : undefined;
        const chooseModel = async (hint = prefer) => provider && modelId ? { provider, id: modelId } : smallCompletionModel(services, hint, { elsePrefer: true });
        const force = regenerate || fields.force === true;
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
        // A runtime may finish its own name during the first turn. Defer without
        // holding a host command open for a minutes-long agent run.
        if (!force && thread.isStreaming() && thread.nativeTitle) {
          pending.set(thread.sessionId, { input, thread });
          return undefined;
        }
        if (!force && thread.nativeTitle) {
          const native = await thread.nativeTitle().catch((error) => {
            services.log("title.native-failed", error instanceof Error ? error.message : String(error));
            return undefined;
          });
          if (!thread.isCurrent() || thread.sessionName()) return undefined;
          if (native) {
            const title = cleanThreadTitle(native);
            await services.setThreadTitle(thread.sessionId, title, "generated");
            return { title };
          }
        }
        // Deferred runtimes include their first answer, which supplies context
        // for image-only prompts. Otherwise the submitted prompt stands in
        // while the transcript has not persisted it yet.
        const conversation = buildTitleConversation(
          (await thread.transcript()).map((message) => ({ role: message.role, content: message.text })),
          [{ role: "user", content: prompt }],
        );
        if (!conversation) {
          if (!force) return undefined;
          throw new Error("The thread has no conversation to title yet.");
        }

        // The thread knows its model even where a new thread's draft named none.
        const ownModels = await thread.completionModels?.().catch(() => []) ?? [];
        const hint = thread.model ?? prefer;
        const ownModel = provider && modelId
          ? ownModels.find((candidate) => candidate.provider === provider && candidate.id === modelId)
          : await smallCompletionModel({ completionModels: async () => ownModels }, hint, { elsePrefer: true });
        const model = ownModel ?? await chooseModel(hint);
        services.log("title.started", model ? `${model.provider}/${model.id}` : "default model");
        // Prefer the harness's own login; other runtimes use the host catalog.
        const request = {
          system: TITLE_SYSTEM_PROMPT,
          prompt: TITLE_USER_PROMPT(conversation),
          maxTokens: 256,
        };
        const title = cleanThreadTitle(await (ownModel
          ? thread.complete(ownModel.provider, ownModel.id, request)
          : services.complete(request, model)));
        // A manual rename or a native name can arrive while inference runs.
        if (!thread.isCurrent() || !force && thread.sessionName()) return undefined;
        await services.setThreadTitle(thread.sessionId, title, "generated");
        services.log("title.generated", title);
        return { title };
      };
      // A client titles a new thread on its own after its first prompt; the prompt stays the device's last change.
      context.registerCommand("generate", (input) => generate(input, false), { audit: { label: "titled a thread", automatic: true } });
      context.registerCommand("regenerate", (input) => generate(input, true), { audit: { label: "regenerated a thread title" } });
      const stop = services.registerTurnObserver({
        pending: (sessionId) => pending.has(sessionId) ? 1 : 0,
        ended: async (sessionId) => {
          const waiting = pending.get(sessionId);
          if (!waiting || waiting.running || waiting.thread.isStreaming()) return;
          if (!waiting.thread.isCurrent()) { pending.delete(sessionId); return; }
          waiting.running = true;
          try { await generate(waiting.input, false); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            services.log("title.failed", message);
            context.emit(TITLE_FAILED_EVENT, { sessionId, message });
          }
          finally { if (pending.get(sessionId) === waiting) pending.delete(sessionId); }
        },
        closed: async (sessionId) => { pending.delete(sessionId); },
      });
      return () => { stop(); pending.clear(); };
    },
  };
}

export default createThreadTitlesHostExtension;
