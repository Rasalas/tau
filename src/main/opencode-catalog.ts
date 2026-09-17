import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";

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

export function withOpenCodeCatalog(provider: Provider, load: (signal: AbortSignal) => Promise<unknown>): Provider {
  const catalog = createProvider({
    id: provider.id,
    auth: provider.auth,
    models: provider.getModels(),
    api: provider,
    fetchModels: async ({ signal }) => catalogModels(provider, await load(signal)),
  });
  return { ...provider, getModels: catalog.getModels, refreshModels: catalog.refreshModels };
}
