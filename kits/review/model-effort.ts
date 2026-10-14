import type { HostExtensionServices } from "tau/host-extension";

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
