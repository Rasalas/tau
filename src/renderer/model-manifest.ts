/**
 * What the catalog does not say about a model: whether it is a legacy
 * generation, and whether it deserves a "new" badge for a while. Hand
 * maintained, like T3 Code's manifest; unmatched models are current.
 * Last reviewed 2026-09-07.
 */
export interface ModelManifestEntry {
  provider?: string | RegExp;
  id: RegExp;
  status?: "legacy";
  badge?: "new";
}

export interface ModelPresentation {
  legacy: boolean;
  badge?: "new";
}

export const MODEL_MANIFEST: readonly ModelManifestEntry[] = [
  { provider: "anthropic", id: /fable-5/u, badge: "new" },
  { provider: "anthropic", id: /^claude-(?:2|3|opus-4|sonnet-4)/u, status: "legacy" },
  { provider: "anthropic", id: /^claude-haiku-4(?!-5)/u, status: "legacy" },
  { provider: /openai/u, id: /^(?:gpt-3|gpt-4|o[134]|codex-mini|chatgpt-4o)/u, status: "legacy" },
  { provider: /google|gemini/u, id: /^gemini-(?:1|2)\./u, status: "legacy" },
];

function providerMatches(rule: string | RegExp | undefined, provider: string): boolean {
  if (rule === undefined) return true;
  return typeof rule === "string" ? rule === provider : rule.test(provider);
}

export function modelPresentation(model: { provider: string; id: string }, manifest: readonly ModelManifestEntry[] = MODEL_MANIFEST): ModelPresentation {
  const presentation: ModelPresentation = { legacy: false };
  for (const entry of manifest) {
    if (!providerMatches(entry.provider, model.provider) || !entry.id.test(model.id)) continue;
    if (entry.status === "legacy") presentation.legacy = true;
    if (entry.badge) presentation.badge = entry.badge;
  }
  return presentation;
}
