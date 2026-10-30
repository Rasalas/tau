import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildTitleConversation, cleanThreadTitle, smallCompletionModel, type HostExtension, type HostExtensionContext, type HostThread } from "tau/host-extension";
import { readTextRuntime, threadWritingModel, writingBudget } from "../_shared/text-generation-host.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_FAILED_EVENT, TITLE_INSTRUCTIONS_SETTING, TITLE_USER_PROMPT, titleInstructions, titleSystemPrompt } from "./protocol.js";

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** A harness writes its title within seconds of the first prompt, long before a long turn ends. */
const NATIVE_POLL_MS = 3_000;
const NATIVE_POLL_LIMIT = 100;

/**
 * Thread Title Generator's host entry. It titles a thread with the model the
 * settings name, else a small one; renaming itself stays a core action.
 */
export function createThreadTitlesHostExtension(): HostExtension {
  return {
    id: THREAD_TITLES_HOST_EXTENSION_ID,
    name: "Thread Title Generator",
    permissions: ["sessions", "workspace:read"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      let disposed = false;
      const jobs = new Map<string, { cancel(): void }>();
      const startJob = (sessionId: string, onCancel?: () => void) => {
        jobs.get(sessionId)?.cancel();
        const job = {
          current: (): boolean => !disposed && jobs.get(sessionId) === job,
          cancel: () => { if (jobs.get(sessionId) === job) jobs.delete(sessionId); onCancel?.(); },
          finish: () => { if (jobs.get(sessionId) === job) jobs.delete(sessionId); },
        };
        jobs.set(sessionId, job);
        return job;
      };
      const readInstructions = async (cwd?: string) => titleInstructions((await services.settings?.(cwd))?.values[TITLE_INSTRUCTIONS_SETTING]);
      type Waiting = { input: unknown; thread: HostThread; running?: boolean; poll?: ReturnType<typeof setInterval> };
      const pending = new Map<string, Waiting>();
      const release = (sessionId: string) => {
        const waiting = pending.get(sessionId);
        if (waiting?.poll) clearInterval(waiting.poll);
        pending.delete(sessionId);
      };
      const pollNative = (sessionId: string, input: unknown, thread: HostThread) => {
        const waiting: Waiting = { input, thread };
        let polls = 0;
        let reading = false;
        waiting.poll = setInterval(() => {
          if (pending.get(sessionId) !== waiting) return;
          if (!thread.isCurrent() || thread.sessionName()) { release(sessionId); return; }
          // Past the limit only the turn's end tries again.
          if (++polls > NATIVE_POLL_LIMIT) { clearInterval(waiting.poll); return; }
          if (reading || waiting.running) return;
          reading = true;
          void thread.nativeTitle?.().then(async (native) => {
            if (!native || pending.get(sessionId) !== waiting || !thread.isCurrent() || thread.sessionName()) return;
            release(sessionId);
            await services.setThreadTitle(thread.sessionId, cleanThreadTitle(native), "generated");
          }).catch(() => undefined).finally(() => { reading = false; });
        }, NATIVE_POLL_MS);
        waiting.poll.unref?.();
        pending.set(sessionId, waiting);
      };
      const generate = async (input: unknown, regenerate: boolean) => {
        const fields = record(input);
        // The settings' model wins; else a small one close to the thread's (`prefer`), the thread's own only when none is small.
        const provider = text(fields.provider);
        const modelId = text(fields.modelId);
        const preferred = record(fields.prefer);
        const prefer = text(preferred.provider) && text(preferred.id) ? { provider: text(preferred.provider), id: text(preferred.id) } : undefined;
        const chooseModel = async (hint = prefer) => provider && modelId ? { provider, id: modelId } : smallCompletionModel(services, hint, { elsePrefer: true });
        const force = regenerate || fields.force === true;
        // Text generation's choice: `pi` never asks the thread's runtime, `thread` always does.
        const runtime = readTextRuntime(fields.runtime);
        const sessionId = typeof fields.sessionId === "string" ? fields.sessionId : undefined;
        const prompt = typeof fields.prompt === "string" ? fields.prompt : "";
        if (services.runtimeOwner() === "pi") {
          const attached = services.attachedRuntime(sessionId);
          if (!attached) throw new Error("The attached Pi runtime is not ready.");
          const requestId = randomUUID();
          const cancel = () => { void attached.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "cancel", { requestId }).catch(() => undefined); };
          const job = startJob(attached.sessionId, cancel);
          try {
            // The host checks settings again before Pi applies the result. A
            // queued or running completion may have used instructions since edited.
            // Attached Pi has no HostThread; the host follows its workspace.
            // settings(undefined) would read only machine values.
            const cwd = services.thread(sessionId)?.cwd ?? services.cwd();
            const instructions = await readInstructions(cwd);
            const chosen = await chooseModel() ?? prefer;
            if (!chosen) throw new Error("Title generation needs a model while Pi is attached to the runtime.");
            if (!job.current()) return undefined;
            let result = await attached.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "generate", {
              provider: chosen.provider, modelId: chosen.id, force, instructions, requestId, deferApply: true,
            });
            // Pi's transport allows only short commands. Waiting for an agent
            // run or a model response must not time out and detach the runtime.
            while (record(result).pending === true && job.current()) {
              await delay(1_000);
              if (!job.current() || instructions !== await readInstructions(cwd)) return undefined;
              if (!job.current()) return undefined;
              result = await attached.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "result", { requestId });
            }
            if (!result || !job.current() || instructions !== await readInstructions(cwd)) return undefined;
            if (!job.current()) return undefined;
            return await attached.invoke(THREAD_TITLES_HOST_EXTENSION_ID, "apply", { requestId });
          } catch (error) {
            if (!job.current()) return undefined;
            throw error;
          } finally { job.finish(); cancel(); }
        }
        // A title the user asked for reaches a thread they are not reading (the rail's selection); an automatic one never reopens it.
        const thread = services.thread(sessionId) ?? (regenerate && sessionId && services.reopenThread ? await services.reopenThread(sessionId) : undefined);
        if (!thread) {
          throw new Error(sessionId ? "That thread is not open any more. Open it again to continue." : "Pi runtime is not ready");
        }
        if (force && thread.isStreaming()) throw new Error("Wait for the active agent run before generating a title.");
        const job = startJob(thread.sessionId);
        const originalName = thread.sessionName();
        try {
          if (force) release(thread.sessionId);
          if (thread.sessionName() && !force) return undefined;
          // A runtime may finish its own name during the first turn. Defer without
          // holding a host command open for a minutes-long agent run.
          if (!force && thread.isStreaming() && thread.nativeTitle) {
            if (!pending.has(thread.sessionId)) pollNative(thread.sessionId, input, thread);
            return undefined;
          }
          if (!force && thread.nativeTitle) {
            const native = await thread.nativeTitle().catch((error) => {
              services.log("title.native-failed", error instanceof Error ? error.message : String(error));
              return undefined;
            });
            if (!job.current() || !thread.isCurrent() || thread.sessionName()) return undefined;
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
          const ownModels = runtime === "pi" ? [] : await thread.completionModels?.().catch(() => []) ?? [];
          const hint = thread.model ?? prefer;
          const ownModel = runtime === "thread"
            ? await threadWritingModel(thread, provider && modelId ? { provider, id: modelId } : undefined)
            : provider && modelId
              ? ownModels.find((candidate) => candidate.provider === provider && candidate.id === modelId)
              : await smallCompletionModel({ completionModels: async () => ownModels }, hint, { elsePrefer: true });
          const model = ownModel ?? await chooseModel(hint);
          services.log("title.started", model ? `${model.provider}/${model.id}${ownModel ? " on the thread's runtime" : ""}` : "default model");
          // An effort is Pi's: it goes with a model chosen in the settings, never with the harness's own login.
          // The settings offer only the levels Pi lists for that model, and Pi takes an unknown one as the default.
          const effort = !ownModel && provider && modelId && text(fields.thinkingLevel).trim() && text(fields.thinkingLevel).trim() !== "off" ? text(fields.thinkingLevel).trim() : undefined;
          // Prefer the harness's own login; other runtimes use the host catalog.
          const instructions = await readInstructions(thread.cwd);
          if (!job.current() || !thread.isCurrent() || thread.sessionName() !== originalName) return undefined;
          const request = {
            system: titleSystemPrompt(instructions),
            prompt: TITLE_USER_PROMPT(conversation),
            ...writingBudget(effort, 256),
            ...(effort ? { thinkingLevel: effort } : {}),
          };
          const title = cleanThreadTitle(await (ownModel
            ? thread.complete(ownModel.provider, ownModel.id, request)
            : services.complete(request, model)));
          // A manual rename or a native name can arrive while inference runs.
          if (!job.current() || !thread.isCurrent() || thread.sessionName() !== originalName) return undefined;
          if (instructions !== await readInstructions(thread.cwd)) return undefined;
          if (!job.current() || !thread.isCurrent() || thread.sessionName() !== originalName) return undefined;
          await services.setThreadTitle(thread.sessionId, title, "generated");
          services.log("title.generated", title);
          return { title };
        } catch (error) {
          if (!job.current() || !thread.isCurrent() || thread.sessionName() !== originalName) return undefined;
          throw error;
        } finally { job.finish(); }
      };
      // A client titles a new thread on its own after its first prompt; the prompt stays the device's last change.
      context.registerCommand("generate", (input) => generate(input, false), { long: true, audit: { label: "titled a thread", automatic: true } });
      context.registerCommand("regenerate", (input) => generate(input, true), { long: true, audit: { label: "regenerated a thread title" } });
      // The turn's end finds a queued turn still streaming; the run's end settles it then.
      const settle = async (sessionId: string) => {
        const waiting = pending.get(sessionId);
        if (!waiting || waiting.running || waiting.thread.isStreaming()) return;
        if (!waiting.thread.isCurrent()) { release(sessionId); return; }
        waiting.running = true;
        try { await generate({ ...record(waiting.input), sessionId }, false); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          services.log("title.failed", message);
          context.emit(TITLE_FAILED_EVENT, { sessionId, message });
        }
        finally { if (pending.get(sessionId) === waiting) release(sessionId); }
      };
      const stop = services.registerTurnObserver({
        pending: (sessionId) => pending.has(sessionId) ? 1 : 0,
        ended: settle,
        runEnded: (sessionId) => { void settle(sessionId); },
        closed: async (sessionId) => { release(sessionId); jobs.get(sessionId)?.cancel(); },
      });
      return () => {
        disposed = true;
        stop();
        for (const job of [...jobs.values()]) job.cancel();
        for (const sessionId of [...pending.keys()]) release(sessionId);
      };
    },
  };
}

export default createThreadTitlesHostExtension;
