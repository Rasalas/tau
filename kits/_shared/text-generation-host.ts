import type { HostExtensionServices, HostThread } from "tau/host-extension";
import type { ModelRef } from "./text-generation.js";

export { readTextRuntime } from "./text-generation.js";

/** Only a dedicated model's current Pi catalog can authorize a stored effort. */
export async function modelEffort(services: HostExtensionServices, model: string, effort: unknown, cwd: string): Promise<string | undefined> {
  if (!model || typeof effort !== "string" || !effort.trim()) return undefined;
  const choices = await services.runtimeChoices?.(cwd, "pi").catch(() => []);
  const catalog = choices?.find((choice) => choice.backend.kind === "pi")?.catalog;
  const chosen = catalog?.models.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
  const levels = chosen ? catalog?.thinkingLevels[model] ?? catalog?.thinkingLevels[chosen.id] ?? [] : [];
  const value = effort.trim();
  return levels.some((level) => level !== "off") && levels.includes(value) ? value : undefined;
}

/** Reasoning shares the output budget, so a short text still needs room to think. */
export function writingBudget(effort: string | undefined, maxTokens: number) {
  return effort && effort !== "off" ? { maxTokens: 16_384, timeoutMs: 120_000 } : { maxTokens };
}

/**
 * The model a thread's own runtime writes with when the user chose that
 * runtime: the chosen one where the runtime offers it, else the thread's.
 * Its runtime keeps its own effort; a Pi effort means nothing there.
 */
export async function threadWritingModel(thread: HostThread | undefined, chosen: ModelRef | undefined): Promise<ModelRef> {
  if (!thread) throw new Error("Open a thread to write with its runtime.");
  const offered = chosen ? await thread.completionModels?.().catch(() => []) ?? [] : [];
  const own = chosen && offered.find((model) => model.provider === chosen.provider && model.id === chosen.id);
  const model = own ? { provider: own.provider, id: own.id } : thread.model;
  if (!model) throw new Error("The thread's runtime names no model to write with.");
  return model;
}
