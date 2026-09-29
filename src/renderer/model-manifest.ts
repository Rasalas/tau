/**
 * What the catalog does not say about a model: whether it is a legacy
 * generation, and whether it deserves a "new" badge for a while. Hand
 * maintained; unmatched models are current.
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
  // Anthropic: Claude 5 and Haiku 4.5 are current; Fable 5.1 is the newest.
  { provider: "anthropic", id: /^claude-fable-5-1/u, badge: "new" },
  { provider: "anthropic", id: /^claude-(?:2|3|opus-4|sonnet-4)/u, status: "legacy" },
  { provider: "anthropic", id: /^claude-haiku-4(?!-5)/u, status: "legacy" },
  // OpenAI: GPT-5.6 (Luna, Sol, Terra) and GPT-6 are current; GPT-6 Astra is the newest.
  { provider: /openai/u, id: /^gpt-6-astra/u, badge: "new" },
  { provider: /openai/u, id: /^(?:gpt-3|gpt-4|o[134]|codex-mini|chatgpt-4o|gpt-realtime)/u, status: "legacy" },
  { provider: /openai/u, id: /^gpt-5(?:\.[1-5])?(?:-|$)/u, status: "legacy" },
  // Google: Gemini 3.5 and later are current; 3.8 Flash is the newest.
  { provider: /google|gemini/u, id: /^gemini-3\.8/u, badge: "new" },
  { provider: /google|gemini/u, id: /^gemini-(?:1|2)\.|^gemini-3(?:-|\.[0-4])/u, status: "legacy" },
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
