/**
 * Each provider's colour (`--provider-*` in core's tokens): a runtime is drawn
 * in its provider's, Pi in its own. Colour here names who, never a state.
 */
export type UsageTone = "openai" | "anthropic" | "google" | "pi" | "other";

/** The tone of a model provider (`openai-codex`) or a runtime (`codex@work`). */
export function toneOf(name: string | undefined): UsageTone {
  const key = (name ?? "").split("@")[0]!.toLowerCase();
  if (key === "pi") return "pi";
  if (/^(openai|codex|chatgpt|gpt|azure-openai)/u.test(key)) return "openai";
  if (/^(anthropic|claude)/u.test(key)) return "anthropic";
  if (/^(google|gemini|vertex|antigravity)/u.test(key)) return "google";
  return "other";
}
