import type { Api, Model, Provider } from "@earendil-works/pi-ai";

const SDK_APIS: Record<string, Api> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/google": "google-generative-ai",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function catalogModels(provider: Provider, value: unknown): Model<Api>[] {
  const catalog = record(record(value)?.[provider.id]);
  const entries = record(catalog?.models);
  if (!entries) throw new Error(`Invalid OpenCode catalog for ${provider.id}`);
  const baseline = provider.getModels();
  return Object.entries(entries).flatMap(([id, raw]): Model<Api>[] => {
    const entry = record(raw);
    if (baseline.some((model) => model.id === id)) return [];
    const npm = record(entry?.provider)?.npm ?? catalog?.npm;
    const api = typeof npm === "string" ? SDK_APIS[npm] : undefined;
    const template = baseline.find((model) => model.api === api);
    const limit = record(entry?.limit);
    const contextWindow = nonnegativeNumber(limit?.context);
    const maxTokens = nonnegativeNumber(limit?.output);
    if (!entry || entry.tool_call !== true || !api || !template || !contextWindow || !maxTokens) return [];
    const cost = record(entry.cost);
    const input = record(entry.modalities)?.input;
    const image = Array.isArray(input) ? input.includes("image") : entry.attachment === true;
    return [{
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      provider: provider.id,
      api,
      baseUrl: template.baseUrl,
      reasoning: entry.reasoning === true,
      input: image ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens,
      cost: {
        input: nonnegativeNumber(cost?.input),
        output: nonnegativeNumber(cost?.output),
        cacheRead: nonnegativeNumber(cost?.cache_read),
        cacheWrite: nonnegativeNumber(cost?.cache_write),
      },
    }];
  });
}

/**
 * The provider with models.dev's entries added to its own list, as plain
 * models: nothing to fetch later, so a runtime publishes them the moment the
 * provider is registered. Without a catalog the provider is returned as is.
 * A catalog that does not name the provider, or is malformed, adds nothing.
 */
export function withOpenCodeCatalog(provider: Provider, catalog: unknown): Provider {
  if (catalog === undefined) return provider;
  let extra: Model<Api>[];
  try {
    extra = catalogModels(provider, catalog);
  } catch {
    return provider;
  }
  if (extra.length === 0) return provider;
  const models = [...provider.getModels(), ...extra];
  return { ...provider, getModels: () => models };
}

/**
 * Only the named providers' entries of models.dev's catalog. The whole catalog
 * parses to several megabytes the process would otherwise hold for an hour.
 */
export function openCodeCatalogSubset(catalog: unknown, providerIds: readonly string[]): unknown {
  const all = record(catalog);
  if (!all) return catalog;
  return Object.fromEntries(providerIds.flatMap((id) => (id in all ? [[id, all[id]]] : [])));
}

const RELEASE_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/u;

/** The id a release date is filed under: no provider prefix, no bracketed variant, no date suffix. */
export function releaseDateKey(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).replace(/\[[^\]]*\]$/u, "").replace(/-\d{8}$/u, "").toLowerCase();
}

/**
 * When each model of models.dev's catalog came out, by `releaseDateKey`, the
 * earliest date any provider gives. Only these strings outlive the parse.
 */
export function releaseDates(catalog: unknown): Map<string, string> {
  const dates = new Map<string, string>();
  for (const provider of Object.values(record(catalog) ?? {})) {
    for (const [id, raw] of Object.entries(record(record(provider)?.models) ?? {})) {
      const date = record(raw)?.release_date;
      if (typeof date !== "string" || !RELEASE_DATE.test(date)) continue;
      const key = releaseDateKey(id);
      const held = dates.get(key);
      if (held === undefined || date < held) dates.set(key, date);
    }
  }
  return dates;
}
