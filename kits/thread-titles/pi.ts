import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTitleConversation, cleanThreadTitle, type PiKitBridge } from "tau/host-extension";
import { TITLE_SYSTEM_PROMPT, TITLE_USER_PROMPT } from "./protocol.js";

interface PendingTitle {
  context: ExtensionContext;
  provider: string;
  modelId: string;
  promise: Promise<{ title: string } | undefined>;
  resolve(value: { title: string } | undefined): void;
  reject(error: unknown): void;
}

/**
 * Thread Title Generator inside a Pi runtime Tau does not own. The host half
 * cannot use Pi's model registry from outside the process, so it forwards
 * `generate` here (`services.attachedRuntime(...).invoke`) and the title is
 * completed and applied with Pi's own registry and session name.
 */
export default function threadTitlesPiExtension(pi: ExtensionAPI, bridge: PiKitBridge): void {
  const pending = new Map<string, PendingTitle>();

  const generate = async (ctx: ExtensionContext, provider: string, modelId: string, force: boolean): Promise<{ title: string } | undefined> => {
    if (pi.getSessionName() && !force) return undefined;
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    const conversation = buildTitleConversation(bridge.transcript(ctx));
    if (!conversation) {
      if (!force) return undefined;
      throw new Error("The thread has no conversation to title yet.");
    }
    const response = await ctx.modelRegistry.complete(model, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: TITLE_USER_PROMPT(conversation) }], timestamp: Date.now() }],
    }, { maxTokens: 48, cacheRetention: "none", sessionId: randomUUID() });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The title model did not complete.");
    }
    const title = cleanThreadTitle(response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n"));
    pi.setSessionName(title);
    return { title };
  };

  bridge.registerCommand("generate", async (ctx, input) => {
    const provider = typeof input.provider === "string" ? input.provider : "";
    const modelId = typeof input.modelId === "string" ? input.modelId : "";
    const force = input.force === true;
    if (!provider || !modelId) throw new Error("Title generation needs a provider and a model.");
    if (ctx.isIdle()) return generate(ctx, provider, modelId, force);
    if (force) throw new Error("Wait for the active agent run before generating a title.");
    // An automatic title waits for the run instead of failing: Tau asks for it
    // as soon as the first prompt is sent, which is while Pi is busy.
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = pending.get(sessionId);
    if (existing) return existing.promise;
    let resolve!: PendingTitle["resolve"];
    let reject!: PendingTitle["reject"];
    const promise = new Promise<{ title: string } | undefined>((accept, fail) => { resolve = accept; reject = fail; });
    pending.set(sessionId, { context: ctx, provider, modelId, promise, resolve, reject });
    return promise;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const waiting = pending.get(sessionId);
    if (!waiting || waiting.context !== ctx) return;
    pending.delete(sessionId);
    try {
      waiting.resolve(await generate(ctx, waiting.provider, waiting.modelId, false));
      bridge.refreshSnapshot(ctx);
    } catch (error) {
      waiting.reject(error);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const waiting = pending.get(sessionId);
    if (!waiting) return;
    pending.delete(sessionId);
    waiting.reject(new Error("The Pi session changed before its title was generated."));
  });
}
