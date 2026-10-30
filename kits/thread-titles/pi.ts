import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTitleConversation, cleanThreadTitle, type PiKitBridge } from "tau/host-extension";
import { TITLE_USER_PROMPT, titleInstructions, titleSystemPrompt } from "./protocol.js";

interface TitleJob {
  context: ExtensionContext;
  sessionId: string;
  provider: string;
  modelId: string;
  instructions: string;
  force: boolean;
  originalName: string | undefined;
  requestId?: string;
  deferApply: boolean;
  title?: string;
  done?: boolean;
  error?: string;
}

interface PendingTitle {
  job: TitleJob;
  promise: Promise<{ title: string } | undefined>;
  resolve(value: { title: string } | undefined): void;
  reject(error: unknown): void;
}

/** Completes with the attached Pi's own model registry and session name. */
export default function threadTitlesPiExtension(pi: ExtensionAPI, bridge: PiKitBridge): void {
  const pending = new Map<string, PendingTitle>();
  const jobs = new Map<string, TitleJob>();
  const current = (job: TitleJob) => jobs.get(job.sessionId) === job
    && bridge.isCurrentSession(job.context)
    && job.context.sessionManager.getSessionId() === job.sessionId
    && pi.getSessionName() === job.originalName;
  const cancel = (sessionId: string) => {
    jobs.delete(sessionId);
    pending.get(sessionId)?.resolve(undefined);
    pending.delete(sessionId);
  };
  const apply = (job: TitleJob) => {
    if (!current(job) || !job.title) return undefined;
    pi.setSessionName(job.title);
    bridge.refreshSnapshot(job.context);
    jobs.delete(job.sessionId);
    return { title: job.title };
  };

  const generate = async (job: TitleJob): Promise<{ title: string } | undefined> => {
    const ctx = job.context;
    try {
      if (!current(job) || job.originalName && !job.force) return undefined;
      const model = ctx.modelRegistry.find(job.provider, job.modelId);
      if (!model) throw new Error(`Unknown model: ${job.provider}/${job.modelId}`);
      const conversation = buildTitleConversation(bridge.transcript(ctx));
      if (!conversation) {
        if (!job.force) return undefined;
        throw new Error("The thread has no conversation to title yet.");
      }
      const response = await ctx.modelRegistry.complete(model, {
        systemPrompt: titleSystemPrompt(job.instructions),
        messages: [{ role: "user", content: [{ type: "text", text: TITLE_USER_PROMPT(conversation) }], timestamp: Date.now() }],
      }, { maxTokens: 256, cacheRetention: "none", sessionId: randomUUID() });
      if (!current(job)) return undefined;
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || "The title model did not complete.");
      }
      job.title = cleanThreadTitle(response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n"));
      return job.deferApply ? { title: job.title } : apply(job);
    } catch (error) {
      if (!current(job)) return undefined;
      throw error;
    } finally {
      if (jobs.get(job.sessionId) === job && !job.deferApply) jobs.delete(job.sessionId);
    }
  };

  bridge.registerCommand("generate", async (ctx, input) => {
    const provider = typeof input.provider === "string" ? input.provider : "";
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    const instructions = titleInstructions(input.instructions);
    const force = input.force === true;
    const requestId = typeof input.requestId === "string" ? input.requestId : undefined;
    const deferApply = input.deferApply === true;
    if (!provider || !modelId) throw new Error("Title generation needs a provider and a model.");
    if (deferApply && !requestId) throw new Error("Deferred title generation needs a request id.");
    if (force && !ctx.isIdle()) throw new Error("Wait for the active agent run before generating a title.");
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = pending.get(sessionId);
    if (existing && current(existing.job) && existing.job.provider === provider && existing.job.modelId === modelId
      && existing.job.instructions === instructions && existing.job.requestId === requestId
      && existing.job.deferApply === deferApply && existing.job.force === force) return deferApply ? { pending: true } : existing.promise;
    cancel(sessionId);
    const job: TitleJob = { context: ctx, sessionId, provider, modelId, instructions, force, originalName: pi.getSessionName(), requestId, deferApply };
    jobs.set(sessionId, job);
    let promise: PendingTitle["promise"];
    if (ctx.isIdle()) promise = generate(job);
    else {
      let resolve!: PendingTitle["resolve"];
      let reject!: PendingTitle["reject"];
      promise = new Promise<{ title: string } | undefined>((accept, fail) => { resolve = accept; reject = fail; });
      pending.set(sessionId, { job, promise, resolve, reject });
    }
    if (deferApply) {
      // Complete outside the bridge request: both the agent run and inference
      // can outlast its 15-second deadline. The host retrieves the result later.
      void promise.then(() => { job.done = true; }, (error: unknown) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.done = true;
      });
      return { pending: true };
    }
    return promise;
  });

  bridge.registerCommand("result", async (ctx, input) => {
    const job = jobs.get(ctx.sessionManager.getSessionId());
    if (!job || !job.deferApply || job.requestId !== input.requestId || !current(job)) return undefined;
    if (!job.done) return { pending: true };
    if (job.error) throw new Error(job.error);
    return job.title ? { title: job.title } : undefined;
  });

  bridge.registerCommand("apply", async (ctx, input) => {
    const job = jobs.get(ctx.sessionManager.getSessionId());
    if (!job || !job.deferApply || typeof input.requestId !== "string" || job.requestId !== input.requestId) return undefined;
    try { return apply(job); }
    finally { if (jobs.get(job.sessionId) === job) jobs.delete(job.sessionId); }
  });

  bridge.registerCommand("cancel", async (ctx, input) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const job = jobs.get(sessionId);
    if (job && typeof input.requestId === "string" && job.requestId === input.requestId) cancel(sessionId);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const waiting = pending.get(sessionId);
    if (!waiting) return;
    pending.delete(sessionId);
    if (!current(waiting.job) || !bridge.isCurrentSession(ctx)) {
      waiting.resolve(undefined);
      if (jobs.get(sessionId) === waiting.job) jobs.delete(sessionId);
      return;
    }
    // Pi creates a fresh context for every event of this same session.
    waiting.job.context = ctx;
    try {
      waiting.resolve(await generate(waiting.job));
    } catch (error) {
      waiting.reject(error);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    jobs.delete(sessionId);
    const waiting = pending.get(sessionId);
    if (!waiting) return;
    pending.delete(sessionId);
    waiting.reject(new Error("The Pi session changed before its title was generated."));
  });
}
