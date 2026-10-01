// The picker's grouping (K142 B): who made a model, and one row per model with its ways. Only the picker's chunk loads it.
import { billingOf, formatPrice, formatTokens, modelFamily, type Offering } from "./model-offerings";

/** Who made a model, by its id; the picker's rail lists these. Order matters: the first that matches. */
const MAKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["openai", /^(gpt|o\d|codex|chatgpt)/u],
  ["anthropic", /^claude/u],
  ["google", /^(gemini|gemma)/u],
  ["xai", /^grok/u],
  ["deepseek", /^deepseek/u],
  ["moonshot", /^kimi/u],
  ["qwen", /^(qwen|qwq)/u],
  ["zai", /^glm/u],
  ["minimax", /^minimax/u],
  ["xiaomi", /^mimo/u],
  ["mistral", /^(mistral|devstral|codestral|magistral|ministral)/u],
  ["nvidia", /^nemotron/u],
];
/** Makers in the rail's order; any other is a gateway's or a runtime's own set, after them. */
export const MAKER_ORDER: readonly string[] = MAKERS.map(([maker]) => maker);
const PROVIDER_MAKERS: Readonly<Record<string, string>> = { "openai-codex": "openai", "google-gemini-cli": "google", "google-vertex": "google" };

/** The maker of a model; one the ids do not tell keeps its provider (OpenCode's "Big Pickle", Cursor's "Auto"). */
export function modelMaker(model: { provider: string; id: string }): string {
  const id = model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
  return MAKERS.find(([, pattern]) => pattern.test(id))?.[0] ?? PROVIDER_MAKERS[model.provider] ?? model.provider;
}

/** One model across every runtime: the picker's row, with each way to run it. */
export interface ModelEntry {
  key: string;
  maker: string;
  name: string;
  /** One offering per runtime and provider; a dated or `[1m]` twin stays behind the plain id. */
  ways: Offering[];
}

const plainness = (offering: Offering) => (offering.model.id.includes("[") ? 2 : 0) + (/-\d{8}$/u.test(offering.model.id) ? 1 : 0);

/** Offerings grouped by model; `prefer` (the model in use) stands for its way over a plainer twin. */
export function modelEntries(offerings: readonly Offering[], prefer?: string): ModelEntry[] {
  const families = new Map<string, Map<string, Offering>>();
  for (const offering of offerings) {
    const family = modelFamily(offering.model);
    const ways = families.get(family) ?? families.set(family, new Map()).get(family)!;
    const route = `${offering.runtime}|${offering.model.provider}`;
    const held = ways.get(route);
    if (!held || held.key !== prefer && (offering.key === prefer || plainness(offering) < plainness(held))) ways.set(route, offering);
  }
  return [...families].map(([key, routes]) => {
    const ways = [...routes.values()];
    const named = ways.find((way) => way.model.name.includes(" ")) ?? ways[0]!;
    return { key, maker: modelMaker(named.model), name: named.model.name.replace(/\s*\(latest\)$/u, ""), ways };
  });
}

/** A row's second line: context (a range across ways), then the API price, or how it is had without one. */
export function entryFacts(ways: readonly Offering[]): string {
  const windows = ways.flatMap((way) => way.model.contextWindow ? [way.model.contextWindow] : []);
  const low = Math.min(...windows);
  const high = Math.max(...windows);
  const context = windows.length ? (low === high ? formatTokens(low) : `${formatTokens(low)}–${formatTokens(high)}`) : undefined;
  const price = ways.find((way) => way.model.price)?.model.price;
  const billings = new Set(ways.map((way) => billingOf(way.model)));
  const paid = price ? `API ${formatPrice(price)}` : billings.size === 1 && billings.has("subscription") ? "plan only" : billings.size === 1 && billings.has("free") ? "free" : undefined;
  return [context, paid].filter(Boolean).join(" · ");
}
