import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TauConfig } from "../shared/contracts.js";

type StreamFn = AgentSession["agent"]["streamFunction"];
type StreamModel = Parameters<StreamFn>[0];
export type SamplingConfig = Pick<TauConfig, "temperature" | "maxTokens">;

/**
 * Models that fail the whole request on a `temperature` ("Unsupported parameter"):
 * the ChatGPT subscription's Codex endpoint, and OpenAI's reasoning models.
 */
export function refusesTemperature(model: Pick<StreamModel, "api" | "reasoning">): boolean {
  if (model.api === "openai-codex-responses") return true;
  return model.reasoning && (model.api === "openai-responses" || model.api === "azure-openai-responses");
}

/**
 * Tau's `temperature` and `maxTokens`, put into the stream options of each
 * request, which every Pi provider maps to its own field. Read per request, so
 * an edit applies to the next turn; a value the caller set (compaction's
 * output budget) wins.
 */
export function withConfiguredSampling(stream: StreamFn, read: () => Promise<SamplingConfig>): StreamFn {
  return async (model, context, options) => {
    const { temperature, maxTokens } = await read().catch((): SamplingConfig => ({}));
    const addTemperature = options?.temperature === undefined && temperature !== undefined && !refusesTemperature(model);
    return stream(model, context, {
      ...options,
      ...(addTemperature ? { temperature } : {}),
      ...(options?.maxTokens === undefined && maxTokens !== undefined ? { maxTokens } : {}),
    });
  };
}
