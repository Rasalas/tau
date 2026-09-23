import type { UiModelBilling, UiModelPrice, UiSubscriptionUsage, UiThreadUsage } from "../shared/contracts.js";
import { costAt, priceOverride } from "../shared/model-prices.js";

/** Tokens one model used, as the runtime counted them. New in API 1.12.0. */
export interface UsageTally {
  provider?: string;
  model?: string;
  /** How it was paid for, when the runtime knows: its login at the time. */
  billing?: UiModelBilling;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** What the runtime itself priced it at; 0 when it named no price. */
  costUsd: number;
  /** Billed responses it sums. */
  turns: number;
}

/** One turn's tally, dated when it ended. */
export interface UsageTurn extends UsageTally {
  at: number;
}

/** A tally as core prices it. Money billed and a subscription's value never share a field. */
export interface PricedUsage {
  /** The tally's own word, else Pi's login for the provider. */
  billing?: UiModelBilling;
  /** Money billed per token; 0 for a subscription. */
  costUsd: number;
  /** For a subscription only: what the provider's API would have charged. */
  apiValueUsd: number;
  /** Where the price came from: the user's, the runtime's, the provider's API list, or none. */
  source: "custom" | "runtime" | "api" | "none";
}

export interface UsagePriceSource {
  /** The user's own prices (`modelPrices`). */
  overrides(): Readonly<Record<string, UiModelPrice>> | undefined;
  /** What the provider's API charges for the model, from Pi's model data. */
  apiPrice(provider: string | undefined, model: string): UiModelPrice | undefined;
  /** Pi reaches the provider through a subscription login. */
  subscription(provider: string): boolean;
}

export function emptyTally(): UsageTally {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };
}

/** Adds `from` into `into`, field by field. */
export function addTally(into: UsageTally, from: UsageTally): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.totalTokens += from.totalTokens;
  into.costUsd += from.costUsd;
  into.turns += from.turns;
}

/** Tallies of the same provider, model and billing summed into one. */
export function mergeTallies(tallies: Iterable<UsageTally>): UsageTally[] {
  const merged = new Map<string, UsageTally>();
  for (const tally of tallies) {
    const key = `${tally.provider ?? ""}\u0000${tally.model ?? ""}\u0000${tally.billing ?? ""}`;
    let into = merged.get(key);
    if (!into) {
      into = { ...emptyTally(), ...(tally.provider ? { provider: tally.provider } : {}), ...(tally.model ? { model: tally.model } : {}), ...(tally.billing ? { billing: tally.billing } : {}) };
      merged.set(key, into);
    }
    addTally(into, tally);
  }
  return [...merged.values()];
}

/**
 * What a tally cost. The user's price wins; then the runtime's own price;
 * then, where the login is a subscription or an API key, the provider's API
 * price. A subscription's figure is its value, never a charge.
 */
export function priceTally(tally: UsageTally, source: UsagePriceSource): PricedUsage {
  const billing = tally.billing ?? (tally.provider && source.subscription(tally.provider) ? "subscription" : undefined);
  const custom = tally.model ? priceOverride(source.overrides(), tally.provider, tally.model) : undefined;
  let value = 0;
  let from: PricedUsage["source"] = "none";
  if (custom) {
    value = costAt(tally, custom);
    from = "custom";
  } else if (tally.costUsd > 0) {
    value = tally.costUsd;
    from = "runtime";
  } else if ((billing === "subscription" || billing === "api-key") && tally.model) {
    const api = source.apiPrice(tally.provider, tally.model);
    if (api) {
      value = costAt(tally, api);
      from = "api";
    }
  }
  return billing === "subscription"
    ? { billing, costUsd: 0, apiValueUsd: value, source: from }
    : { ...(billing ? { billing } : {}), costUsd: value, apiValueUsd: 0, source: from };
}

/** A thread's total over its tallies, the subscription's share apart; undefined when nothing was used. */
export function threadUsageFrom(tallies: readonly UsageTally[], source: UsagePriceSource): UiThreadUsage | undefined {
  if (tallies.length === 0) return undefined;
  const usage: UiThreadUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 };
  let subscription: UiSubscriptionUsage | undefined;
  for (const tally of tallies) {
    const priced = priceTally(tally, source);
    usage.inputTokens += tally.inputTokens;
    usage.outputTokens += tally.outputTokens;
    usage.cacheReadTokens += tally.cacheReadTokens;
    usage.cacheWriteTokens += tally.cacheWriteTokens;
    usage.totalTokens += tally.totalTokens;
    usage.turns += tally.turns;
    usage.costUsd += priced.costUsd;
    if (priced.billing !== "subscription") continue;
    subscription ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, turns: 0, apiValueUsd: 0 };
    subscription.inputTokens += tally.inputTokens;
    subscription.outputTokens += tally.outputTokens;
    subscription.cacheReadTokens += tally.cacheReadTokens;
    subscription.cacheWriteTokens += tally.cacheWriteTokens;
    subscription.totalTokens += tally.totalTokens;
    subscription.turns += tally.turns;
    subscription.apiValueUsd += priced.apiValueUsd;
  }
  return subscription ? { ...usage, subscription } : usage;
}

/** Reads the fields of a tally another module handed over; undefined when it is not one. */
export function readUsageTally(value: unknown): UsageTally | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const count = (field: string): number | undefined => {
    const number = raw[field];
    return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "turns"] as const;
  const tally = emptyTally();
  for (const field of fields) {
    const number = count(field);
    if (number === undefined) return undefined;
    tally[field] = number;
  }
  const billing = raw.billing;
  return {
    ...(typeof raw.provider === "string" && raw.provider ? { provider: raw.provider } : {}),
    ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
    ...(billing === "subscription" || billing === "api-key" || billing === "free" || billing === "local" ? { billing } : {}),
    ...tally,
  };
}

/** Reads a stored turn; undefined when it is not one. */
export function readUsageTurn(value: unknown): UsageTurn | undefined {
  const tally = readUsageTally(value);
  const at = value && typeof value === "object" ? (value as { at?: unknown }).at : undefined;
  return tally && typeof at === "number" && Number.isFinite(at) ? { ...tally, at } : undefined;
}

/** Every readable turn of a stored list; undefined when the value is no list. */
export function readUsageTurns(value: unknown): UsageTurn[] | undefined {
  return Array.isArray(value) ? value.flatMap((item) => readUsageTurn(item) ?? []) : undefined;
}

/** Turns a thread keeps one by one; older ones are folded into the first. */
export const MAX_USAGE_TURNS = 2_000;

/** The list with `turn` appended; past the limit the two oldest become one. */
export function appendUsageTurn(turns: readonly UsageTurn[], turn: UsageTurn, max = MAX_USAGE_TURNS): UsageTurn[] {
  const next = [...turns, turn];
  while (next.length > Math.max(2, max)) {
    const [first, second] = next.splice(0, 2) as [UsageTurn, UsageTurn];
    const folded: UsageTurn = { ...emptyTally(), at: second.at };
    if (first.model === second.model && first.model) folded.model = first.model;
    if (first.provider === second.provider && first.provider) folded.provider = first.provider;
    if (first.billing === second.billing && first.billing) folded.billing = first.billing;
    addTally(folded, first);
    addTally(folded, second);
    next.unshift(folded);
  }
  return next;
}

/**
 * The turns of a thread that kept only a running total before it kept turns:
 * one entry, dated by its last activity, with no billing known.
 */
export function legacyUsageTurn(usage: Omit<UsageTally, "provider" | "model" | "billing">, at: number, model?: { provider?: string; model?: string }): UsageTurn {
  return {
    ...(model?.provider ? { provider: model.provider } : {}),
    ...(model?.model ? { model: model.model } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    turns: usage.turns,
    at,
  };
}

/** A thread's total from its turns without any pricing: the runtime's own figures, all billed. */
export function unpricedUsage(tallies: readonly UsageTally[]): UiThreadUsage | undefined {
  if (tallies.length === 0) return undefined;
  const total = emptyTally();
  for (const tally of tallies) addTally(total, tally);
  return { inputTokens: total.inputTokens, outputTokens: total.outputTokens, cacheReadTokens: total.cacheReadTokens, cacheWriteTokens: total.cacheWriteTokens, totalTokens: total.totalTokens, costUsd: total.costUsd, turns: total.turns };
}

export interface UsagePricingOptions {
  /** Pi's model data and logins; loaded once, off the start path. */
  load(): Promise<{ apiPrice: UsagePriceSource["apiPrice"]; subscription: UsagePriceSource["subscription"] } | undefined>;
  /** The user's prices as the config holds them now. */
  readPrices(): Readonly<Record<string, UiModelPrice>> | undefined;
  /** Prices changed: totals already published may be stale. */
  onChange(): void;
  log?(label: string, detail?: string): void;
}

/**
 * The host's prices. Until Pi's model data is loaded a tally is priced by the
 * runtime and the user alone; the change is announced once the data is there.
 */
export class UsagePricing implements UsagePriceSource {
  private data?: { apiPrice: UsagePriceSource["apiPrice"]; subscription: UsagePriceSource["subscription"] };
  private loading?: Promise<void>;
  private prices: Readonly<Record<string, UiModelPrice>> | undefined;
  private pricesKey: string;

  constructor(private readonly options: UsagePricingOptions) {
    this.prices = options.readPrices();
    this.pricesKey = JSON.stringify(this.prices ?? {});
  }

  /** Loads Pi's data once; resolves when prices are as good as they get. */
  ready(): Promise<void> {
    this.loading ??= this.options.load().then((data) => {
      if (!data) { this.loading = undefined; return; }
      this.data = data;
      this.options.onChange();
    }, (error: unknown) => {
      this.loading = undefined;
      this.options.log?.("usage-pricing.load-failed", error instanceof Error ? error.message : String(error));
    });
    return this.loading;
  }

  /** The config may hold other prices now; announces a change only when it does. */
  reloadPrices(): void {
    const next = this.options.readPrices();
    const key = JSON.stringify(next ?? {});
    if (key === this.pricesKey) return;
    this.prices = next;
    this.pricesKey = key;
    this.options.onChange();
  }

  overrides(): Readonly<Record<string, UiModelPrice>> | undefined { return this.prices; }
  apiPrice(provider: string | undefined, model: string): UiModelPrice | undefined { return this.data?.apiPrice(provider, model); }
  subscription(provider: string): boolean { return this.data?.subscription(provider) ?? false; }

  price(tally: UsageTally): PricedUsage { return priceTally(tally, this); }
  threadUsage(tallies: readonly UsageTally[]): UiThreadUsage | undefined { return threadUsageFrom(tallies, this); }
}
