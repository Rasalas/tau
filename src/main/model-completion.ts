import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HostCommandError } from "./host-extension-errors.js";
import type { CompletionRequest } from "./runtime-types.js";

type Model = Parameters<ModelRuntime["completeSimple"]>[0];
type Runtime = Pick<ModelRuntime, "completeSimple" | "streamSimple"> & Partial<Pick<ModelRuntime, "isUsingOAuth" | "getAuth" | "getProvider">>;

/** A Pi login that needs the user, not a broken caller: it never counts toward deactivating a package. */
class ModelLoginError extends HostCommandError {
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ModelLoginError";
    this.cause = cause;
  }
}

/**
 * Resolves an OAuth login before the request, where Pi still reports why it
 * failed; the request itself would only return the message, stack included.
 */
async function requireLogin(runtime: Runtime, model: Model, signal: AbortSignal | undefined): Promise<void> {
  if (!runtime.getAuth || runtime.isUsingOAuth?.(model.provider) !== true) return;
  try {
    await runtime.getAuth(model, signal ? { signal } : {});
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (!(error instanceof Error) || error.name !== "ModelsError" || (code !== "oauth" && code !== "auth")) return;
    const name = runtime.getProvider?.(model.provider)?.name || model.provider;
    throw new ModelLoginError(/\binvalid_grant\b/u.test(error.message)
      ? `Pi's ${name} login has expired. Sign in again on Pi's card under Settings → Providers.`
      : `Pi could not refresh its ${name} login. Sign in again on Pi's card under Settings → Providers if this keeps happening.`, error);
  }
}

/**
 * One request on a model runtime. With `onText` the answer streams and each
 * delta is reported as it arrives; the returned text is the whole answer
 * either way.
 */
export async function completeText(
  runtime: Runtime,
  model: Model,
  request: CompletionRequest,
  attribution: { sessionId: string; headers?: Record<string, string> },
): Promise<string> {
  const context = { systemPrompt: request.system, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: request.prompt }], timestamp: Date.now() }] };
  const options = {
    maxTokens: request.maxTokens ?? 48,
    cacheRetention: "none" as const,
    timeoutMs: request.timeoutMs ?? 30_000,
    sessionId: attribution.sessionId,
    ...(attribution.headers ? { headers: attribution.headers } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
  await requireLogin(runtime, model, request.signal);
  let response: AssistantMessage;
  if (request.onText) {
    const stream = runtime.streamSimple(model, context, options);
    for await (const event of stream) if (event.type === "text_delta") request.onText(event.delta);
    response = await stream.result();
  } else {
    response = await runtime.completeSimple(model, context, options);
  }
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || "The model did not complete.");
  }
  return response.content.map((part) => part.type === "text" ? part.text : "").join("").trim();
}
