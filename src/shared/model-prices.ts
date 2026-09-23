import type { UiModel, UiModelPrice } from "./contracts.js";

/** More than any price list a person keeps by hand. */
const MAX_PRICES = 1_000;
/** Dollars per million tokens; beyond this a number is a typo. */
const MAX_RATE = 100_000;

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE ? value : undefined;
}

/** One entry of `modelPrices`, or undefined when it is not a price. */
export function readModelPrice(value: unknown): UiModelPrice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const input = rate(raw.input);
  const output = rate(raw.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = raw.cacheRead === undefined ? undefined : rate(raw.cacheRead);
  const cacheWrite = raw.cacheWrite === undefined ? undefined : rate(raw.cacheWrite);
  if ((raw.cacheRead !== undefined && cacheRead === undefined) || (raw.cacheWrite !== undefined && cacheWrite === undefined)) return undefined;
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

export function validPriceKey(key: string): boolean {
  return key.trim() === key && key.length > 0 && key.length <= 300 && !key.startsWith("/") && !key.endsWith("/");
}

/** Every valid entry of a `modelPrices` record; the rest is dropped. */
export function readModelPrices(value: unknown): Record<string, UiModelPrice> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, UiModelPrice> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_PRICES)) {
    const price = validPriceKey(key) ? readModelPrice(entry) : undefined;
    if (price) result[key] = price;
  }
  return result;
}

/** Ids a model may be priced under: as named, without a bracketed variant (`[1m]`), without a date suffix. */
export function priceIds(id: string): string[] {
  const bare = id.replace(/\[[^\]]*\]$/u, "");
  return [...new Set([id, bare, bare.replace(/-\d{8}$/u, "")])];
}

/**
 * The user's price for a model: `provider/id` first, then the bare id, each
 * also without a variant or a date suffix.
 */
export function priceOverride(prices: Readonly<Record<string, UiModelPrice>> | undefined, provider: string | undefined, id: string): UiModelPrice | undefined {
  if (!prices) return undefined;
  const ids = priceIds(id);
  if (provider) {
    for (const candidate of ids) {
      const found = prices[`${provider}/${candidate}`];
      if (found) return found;
    }
  }
  for (const candidate of ids) {
    const found = prices[candidate];
    if (found) return found;
  }
  return undefined;
}

/** The model with the user's price in place of the catalog's, and whether one applied. */
export function withPriceOverride(model: UiModel, prices: Readonly<Record<string, UiModelPrice>> | undefined): { model: UiModel; custom: boolean } {
  const price = priceOverride(prices, model.provider, model.id);
  return price ? { model: { ...model, price }, custom: true } : { model, custom: false };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Dollars for these tokens at this price; a cache rate left out is the input rate. */
export function costAt(tokens: TokenCounts, price: UiModelPrice): number {
  return (
    tokens.inputTokens * price.input
    + tokens.outputTokens * price.output
    + tokens.cacheReadTokens * (price.cacheRead ?? price.input)
    + tokens.cacheWriteTokens * (price.cacheWrite ?? price.input)
  ) / 1_000_000;
}
