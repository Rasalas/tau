import type { UiModel, UiModelBilling, UiModelPrice } from "../shared/contracts.js";
import { priceIds } from "../shared/model-prices.js";
import type { HostCatalogModel, HostRuntimeNewThreadCatalog } from "./host-extensions.js";

/** What Pi's model data says of a model, as far as a catalog shows it. */
export interface PiModelData {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead?: number; readonly cacheWrite?: number };
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

type ModelFacts = Pick<UiModel, "price" | "contextWindow" | "maxOutput" | "images" | "reasoning" | "releasedAt">;

const LOCAL_URL = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/iu;

/** A price of zero is Pi's "unknown or free", never a price to show. */
function priceOf(cost: PiModelData["cost"]): UiModelPrice | undefined {
  if (!cost || !(cost.input > 0 || cost.output > 0)) return undefined;
  return {
    input: cost.input,
    output: cost.output,
    ...(cost.cacheRead ? { cacheRead: cost.cacheRead } : {}),
    ...(cost.cacheWrite ? { cacheWrite: cost.cacheWrite } : {}),
  };
}

function factsOf(model: PiModelData): ModelFacts {
  const price = priceOf(model.cost);
  return {
    ...(price ? { price } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxOutput: model.maxTokens } : {}),
    ...(model.input ? { images: model.input.includes("image") } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
  };
}

/**
 * Pi's model data as a reference for every runtime's catalog. It scans the
 * list Pi already holds instead of indexing a copy of it.
 */
export class ModelPriceBook {
  constructor(
    private readonly models: () => readonly PiModelData[],
    /** When a model came out, by id; models.dev's dates. */
    private readonly releaseDate: (id: string) => string | undefined = () => undefined,
  ) {}

  releasedAt(id: string): string | undefined {
    for (const candidate of priceIds(id)) {
      const date = this.releaseDate(candidate);
      if (date) return date;
    }
    return undefined;
  }

  /**
   * The facts Pi has for a model: the same provider's entry first, the price
   * of any provider that sells the same id when that entry has none. A
   * subscription's model costs what the API sells it for.
   */
  lookup(provider: string, id: string): ModelFacts | undefined {
    const models = this.models();
    const ids = priceIds(id);
    const pick = (test: (model: PiModelData, candidate: string) => boolean) => {
      for (const candidate of ids) {
        const found = models.find((model) => test(model, candidate));
        if (found) return found;
      }
      return undefined;
    };
    const own = pick((model, candidate) => model.provider === provider && model.id === candidate);
    const priced = own && priceOf(own.cost) ? own : pick((model, candidate) => model.id === candidate && priceOf(model.cost) !== undefined);
    const base = own ?? priced;
    const releasedAt = this.releasedAt(id);
    if (!base) return releasedAt ? { releasedAt } : undefined;
    const price = priced ? priceOf(priced.cost) : undefined;
    return { ...factsOf(base), ...(price ? { price } : {}), ...(releasedAt ? { releasedAt } : {}) };
  }

  /** The model with what its backend left out filled in; `apiModelId` stays behind. */
  enrich(model: HostCatalogModel): UiModel {
    const { apiModelId, ...named } = model;
    const facts = this.lookup(model.provider, apiModelId ?? model.id);
    if (!facts) return named;
    const missing = Object.entries(facts).filter(([key]) => named[key as keyof ModelFacts] === undefined);
    return { ...named, ...Object.fromEntries(missing) };
  }
}

/** Pi's own offering: its subscription login, a model on this machine, one without a price, or an API key. */
export function piBilling(model: PiModelData, subscription: boolean): UiModelBilling {
  if (subscription) return "subscription";
  if (model.baseUrl && LOCAL_URL.test(model.baseUrl)) return "local";
  return priceOf(model.cost) ? "api-key" : "free";
}

export interface PiCatalogInput {
  /** The models the user's configuration can reach. */
  available: readonly PiModelData[];
  /** True where Pi reaches the provider through its subscription login. */
  subscription(provider: string): boolean;
  /** What a new Pi thread runs on unasked. */
  defaultModel?: PiModelData;
  book: ModelPriceBook;
}

/** Pi's catalog before any thread exists; thinking levels stay the thread's own. */
export function piNewThreadCatalog(input: PiCatalogInput): HostRuntimeNewThreadCatalog {
  const model = (entry: PiModelData): UiModel => {
    const subscription = input.subscription(entry.provider);
    // A subscription model Pi lists at no price still has its API price elsewhere in the book.
    const price = priceOf(entry.cost) ?? (subscription ? input.book.lookup(entry.provider, entry.id)?.price : undefined);
    const releasedAt = input.book.releasedAt(entry.id);
    return {
      provider: entry.provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(subscription ? { login: "subscription" as const } : {}),
      billing: piBilling(entry, subscription),
      ...factsOf(entry),
      ...(price ? { price } : {}),
      ...(releasedAt ? { releasedAt } : {}),
    };
  };
  return {
    models: input.available.map(model),
    ...(input.defaultModel ? { model: model(input.defaultModel) } : {}),
    thinkingLevels: {},
  };
}
