/**
 * The provider of a model an ACP agent serves on its own account (Antigravity,
 * Cursor). Neither names it: ACP lists a model as id and name, Cursor's
 * `cursor/list_available_models` as value, name and options. So the id, then
 * the name, is matched against the makers' model names below; anything else
 * is the runtime's own (`fallback`). Provider ids are Pi's, so prices match.
 */
const MAKERS: ReadonlyArray<readonly [provider: string, pattern: RegExp]> = [
  ["anthropic", /\b(?:claude|sonnet|opus|haiku)\b/u],
  ["openai", /\b(?:gpt|chatgpt|codex|o[1-9])\b/u],
  ["google", /\b(?:gemini|gemma)\b/u],
  ["xai", /\bgrok\b/u],
  ["deepseek", /\bdeepseek\b/u],
  ["moonshotai", /\bkimi\b/u],
  ["zai", /\bglm\b/u],
];

export function modelProvider(model: { id: string; name?: string }, fallback: string): string {
  for (const text of [model.id, model.name ?? ""]) {
    const lower = text.toLowerCase();
    const found = MAKERS.find(([, pattern]) => pattern.test(lower));
    if (found) return found[0];
  }
  return fallback;
}
