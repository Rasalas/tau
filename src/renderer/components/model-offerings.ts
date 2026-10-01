import type { ThreadBackendKind, UiModel, UiModelPrice } from "../../shared/contracts";
import { DEFAULT_RUNTIME } from "../runtime-marks";

/**
 * An offering is one runtime's way to reach a model: the same GPT-5.6 Luna
 * over Pi's OpenAI login and over Codex is two offerings of one model. The
 * picker lists, searches, sorts and filters offerings; this module is the
 * logic without the DOM.
 */
export interface Offering {
  /** Unique across runtimes; see `offeringKey`. */
  key: string;
  runtime: ThreadBackendKind;
  runtimeLabel: string;
  model: UiModel;
  /** The reasoning levels its runtime names for it, when it named any. */
  levels: readonly string[];
  favourite: boolean;
  hidden: boolean;
  legacy: boolean;
  isNew: boolean;
  /** Where the runtime lists it: its own catalog order, or the user's. */
  position: number;
  /** `model.price` is the user's own (`modelPrices`), not the catalog's. */
  customPrice?: boolean;
}

export type OfferingSort = "relevance" | "price" | "context" | "newest";
export type BillingFilter = "subscription" | "api" | "free";
export type CapabilityFilter = "images" | "reasoning";

export interface OfferingFilters {
  billing: ReadonlySet<BillingFilter>;
  capabilities: ReadonlySet<CapabilityFilter>;
}

export const NO_FILTERS: OfferingFilters = { billing: new Set(), capabilities: new Set() };

/** `provider/id` for Pi, whose keys predate other runtimes; `<runtime>:provider/id` otherwise. */
export function offeringKey(runtime: ThreadBackendKind | undefined, model: { provider: string; id: string }): string {
  const bare = `${model.provider}/${model.id}`;
  return (runtime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME ? bare : `${runtime}:${bare}`;
}

/** The key a runtime's `modelPreferences` entry files a model under. */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Offerings of the same model share this: the id without a provider prefix, variant or date. */
export function modelFamily(model: { id: string }): string {
  return model.id.slice(model.id.lastIndexOf("/") + 1).replace(/\[[^\]]*\]$/u, "").replace(/-\d{8}$/u, "").toLowerCase();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/gu, " ").trim();
}

/** Lower is better; undefined when `token` is not in `field`. */
function scoreField(field: string, token: string, base: number): number | undefined {
  if (field === token) return base;
  if (field.startsWith(token)) return base + 2;
  const at = field.indexOf(token);
  if (at > 0 && /[\s\-./:()]/u.test(field[at - 1]!)) return base + 4;
  if (at > 0) return base + 6;
  return token.length >= 3 && looselyContains(field, token) ? base + 100 : undefined;
}

/** `token`'s letters in order within a short stretch of `field` ("gpt56" in "gpt-5.6"), not scattered across it. */
function looselyContains(field: string, token: string): boolean {
  for (let start = field.indexOf(token[0]!); start >= 0; start = field.indexOf(token[0]!, start + 1)) {
    let at = start;
    let found = true;
    for (const char of token.slice(1)) {
      at = field.indexOf(char, at + 1);
      if (at < 0) { found = false; break; }
    }
    if (found && at - start < token.length + 3) return true;
    if (!found) return false;
  }
  return false;
}

/**
 * How well `offering` answers `query`, lower is better; undefined when some
 * word of the query is in none of its names. Every word must match; the name
 * counts before the id, the id before provider and runtime.
 */
export function searchScore(offering: Offering, query: string, providerName: (provider: string) => string = (provider) => provider): number | undefined {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  const fields = [
    normalize(offering.model.name),
    normalize(offering.model.id),
    normalize(providerName(offering.model.provider)),
    normalize(offering.model.provider),
    normalize(offering.runtimeLabel),
  ];
  let score = 0;
  for (const token of tokens) {
    let best: number | undefined;
    fields.forEach((field, index) => {
      const found = scoreField(field, token, index * 10);
      if (found !== undefined && (best === undefined || found < best)) best = found;
    });
    if (best === undefined) return undefined;
    score += best;
  }
  return offering.favourite ? score - 24 : score;
}

/** Input and output per million tokens, the figure the price sort compares. */
export function priceValue(price: UiModelPrice | undefined): number | undefined {
  return price ? price.input + price.output : undefined;
}

/**
 * Subscription offerings come before every other one; within both groups the
 * API price decides, free and local count as nothing, an unknown price goes last.
 */
function priceRank(offering: Offering): [number, number] {
  const billing = offering.model.billing ?? (offering.model.login === "subscription" ? "subscription" : undefined);
  const group = billing === "subscription" ? 0 : 1;
  const price = priceValue(offering.model.price);
  if (price !== undefined) return [group, price];
  return [group, billing === "free" || billing === "local" ? 0 : Number.POSITIVE_INFINITY];
}

function compareNames(a: Offering, b: Offering): number {
  return a.model.name.localeCompare(b.model.name) || a.runtimeLabel.localeCompare(b.runtimeLabel);
}

/** A comparator for `sort`; `relevance` keeps the order it is given (a score or the catalog's). */
export function offeringComparator(sort: OfferingSort): (a: Offering, b: Offering) => number {
  switch (sort) {
    case "price":
      return (a, b) => {
        const [groupA, priceA] = priceRank(a);
        const [groupB, priceB] = priceRank(b);
        if (groupA !== groupB) return groupA - groupB;
        if (priceA !== priceB) return priceA < priceB ? -1 : 1;
        return compareNames(a, b);
      };
    case "context":
      return (a, b) => (b.model.contextWindow ?? -1) - (a.model.contextWindow ?? -1) || compareNames(a, b);
    case "newest":
      return (a, b) => {
        const dateA = a.model.releasedAt ?? "";
        const dateB = b.model.releasedAt ?? "";
        return dateA === dateB ? compareNames(a, b) : dateA < dateB ? 1 : -1;
      };
    default:
      return () => 0;
  }
}

export function billingOf(model: UiModel): BillingFilter | undefined {
  const billing = model.billing ?? (model.login === "subscription" ? "subscription" : undefined);
  if (billing === "subscription") return "subscription";
  if (billing === "api-key") return "api";
  if (billing === "free" || billing === "local") return "free";
  return undefined;
}

export function passesFilters(offering: Offering, filters: OfferingFilters): boolean {
  if (filters.billing.size > 0) {
    const billing = billingOf(offering.model);
    if (!billing || !filters.billing.has(billing)) return false;
  }
  if (filters.capabilities.has("images") && offering.model.images !== true) return false;
  if (filters.capabilities.has("reasoning") && offering.model.reasoning !== true && offering.levels.length < 2) return false;
  return true;
}

export function filterCount(filters: OfferingFilters): number {
  return filters.billing.size + filters.capabilities.size;
}

/**
 * Search results across runtimes: the offerings that match, best first by
 * `sort` (by score when `relevance`), grouped by model so each model's
 * offerings stand together, in the order of each group's best one. On a tie
 * the runtime on hand (`preferred`) goes first.
 */
export function searchOfferings(
  offerings: readonly Offering[],
  query: string,
  sort: OfferingSort,
  providerName?: (provider: string) => string,
  preferred?: ThreadBackendKind,
): Offering[][] {
  const scored = offerings.flatMap((offering) => {
    const score = searchScore(offering, query, providerName);
    return score === undefined ? [] : [{ offering, score }];
  });
  const compare = offeringComparator(sort);
  const home = (offering: Offering) => (offering.runtime === preferred ? 0 : 1);
  scored.sort((a, b) => (sort === "relevance" ? a.score - b.score : 0) || compare(a.offering, b.offering) || a.score - b.score
    || home(a.offering) - home(b.offering) || compareNames(a.offering, b.offering));
  const groups = new Map<string, Offering[]>();
  for (const { offering } of scored) {
    const family = modelFamily(offering.model);
    const group = groups.get(family);
    if (group) group.push(offering);
    else groups.set(family, [offering]);
  }
  return [...groups.values()];
}

/** Browsing one runtime: its own order (the user's first), or `sort`'s. */
export function sortOfferings(offerings: readonly Offering[], sort: OfferingSort): Offering[] {
  const compare = offeringComparator(sort);
  return [...offerings].sort((a, b) => compare(a, b) || a.position - b.position);
}

/** A runtime's models in the order the user gave, the rest after in their own order. */
export function orderedPositions(models: readonly { provider: string; id: string }[], order: readonly string[] | undefined): Map<string, number> {
  const positions = new Map<string, number>();
  const rank = new Map((order ?? []).map((key, index) => [key, index] as const));
  const keyed = models.map((model, index) => ({ key: modelKey(model), index }));
  keyed.sort((a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index);
  keyed.forEach((entry, position) => positions.set(entry.key, position));
  return positions;
}

function trim(value: number): string {
  return value >= 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value * 100) / 100);
}

/** `$0.2/$1.2`: input and output per million tokens. */
export function formatPrice(price: UiModelPrice): string {
  return `$${trim(price.input)}/$${trim(price.output)}`;
}

/** `400k`, `1M`, `1.05M` tokens. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 10_000) / 100}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export const BILLING_LABELS: Record<BillingFilter, string> = { subscription: "Plan", api: "API", free: "Free" };

/** The access badge of a row: a word and what it means. */
export function billingBadge(model: UiModel): { label: string; title: string } | undefined {
  const billing = model.billing ?? (model.login === "subscription" ? "subscription" : undefined);
  switch (billing) {
    case "subscription": return { label: "Plan", title: "Paid by the subscription plan you signed in with" };
    case "api-key": return { label: "API", title: "Paid per token with an API key" };
    case "free": return { label: "Free", title: "Free to use" };
    case "local": return { label: "Local", title: "Runs on this machine" };
    default: return undefined;
  }
}

/** The same model on the same provider with another context window: the thinking menu's choices, smallest first. */
export function contextChoices(models: readonly UiModel[], current: UiModel | undefined): Array<{ model: UiModel; tokens: number }> {
  if (!current) return [];
  const family = modelFamily(current);
  const byWindow = new Map<number, UiModel>();
  for (const model of models) {
    if (model.provider !== current.provider || modelFamily(model) !== family) continue;
    const tokens = model.contextWindow ?? (/\[1m\]$/iu.test(model.id) ? 1_000_000 : 0);
    if (!byWindow.has(tokens) || model.id === current.id) byWindow.set(tokens, model);
  }
  return byWindow.size > 1 ? [...byWindow].sort(([a], [b]) => a - b).map(([tokens, model]) => ({ model, tokens })) : [];
}
