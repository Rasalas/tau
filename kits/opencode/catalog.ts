import type { HostCatalogModel, HostRuntimeNewThreadCatalog, UiModelBilling } from "tau/host-extension";
import type { OpenCodeModelInfo, OpenCodeProvider, OpenCodeProviderList } from "./client.js";
import type { OpenCodeModelRef, OpenCodeStoredModel } from "./session-store.js";

/** The effort picker's first entry: the model's own default. */
export const DEFAULT_VARIANT = "default";

/** Providers reached through a plan the user pays for by the month, not per token. */
const SUBSCRIPTION_PROVIDERS = /^(?:opencode-go|github-copilot|.*-coding-plan(?:-.+)?|.*-token-plan(?:-.+)?|kimi-code-plan.*|zai-coding-plan)$/u;
/** Programs on the user's own machine. */
const LOCAL_PROVIDERS = new Set(["lmstudio", "ollama", "llama.cpp", "llamacpp", "atomic-chat"]);
/** Providers that bill per token when a model has a price, and whose price is zero only under a consumer login. */
const LOGIN_PROVIDERS = new Set(["openai", "anthropic"]);

function priced(model: OpenCodeModelInfo): boolean {
  return (model.cost?.input ?? 0) > 0 || (model.cost?.output ?? 0) > 0;
}

/**
 * How a model is paid for. OpenCode names the provider and a price, not the
 * kind of login: a monthly plan and a local program are known by provider, a
 * price of zero means free (OpenCode Zen's free models) or, for OpenAI and
 * Anthropic, a consumer login OpenCode prices at zero.
 */
export function openCodeBilling(provider: string, model: OpenCodeModelInfo): UiModelBilling {
  if (LOCAL_PROVIDERS.has(provider)) return "local";
  if (SUBSCRIPTION_PROVIDERS.test(provider)) return "subscription";
  if (priced(model)) return "api-key";
  return LOGIN_PROVIDERS.has(provider) ? "subscription" : "free";
}

export function variantsOf(model: OpenCodeModelInfo): string[] {
  return Object.keys(model.variants ?? {});
}

/** The providers a thread can use: those OpenCode reports connected. */
export function connectedProviders(list: OpenCodeProviderList): OpenCodeProvider[] {
  const connected = new Set(list.connected);
  return list.all.filter((provider) => connected.has(provider.id));
}

function usable(model: OpenCodeModelInfo): boolean {
  return model.status !== "deprecated" && Boolean(model.id);
}

/** A model the catalog shows; a free or subscription offer leaves the price to the host's model data. */
export function catalogModel(provider: OpenCodeProvider, model: OpenCodeModelInfo): HostCatalogModel {
  const billing = openCodeBilling(provider.id, model);
  const cost = model.cost;
  return {
    provider: provider.id,
    id: model.id,
    name: model.name?.trim() || model.id,
    billing,
    ...(billing === "api-key" && cost ? { price: { input: cost.input ?? 0, output: cost.output ?? 0, ...(cost.cache?.read ? { cacheRead: cost.cache.read } : {}), ...(cost.cache?.write ? { cacheWrite: cost.cache.write } : {}) } } : {}),
    ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
    ...(model.limit?.output ? { maxOutput: model.limit.output } : {}),
    ...(model.capabilities?.input?.image !== undefined ? { images: model.capabilities.input.image } : {}),
    ...(model.capabilities?.reasoning !== undefined ? { reasoning: model.capabilities.reasoning } : {}),
  };
}

export function storedModels(list: OpenCodeProviderList): OpenCodeStoredModel[] {
  return connectedProviders(list).flatMap((provider) => Object.values(provider.models).filter(usable).map((model) => ({
    provider: provider.id,
    id: model.id,
    name: model.name?.trim() || model.id,
    variants: variantsOf(model),
    ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
  })));
}

/** The levels a model offers: its own default first, then OpenCode's variants. */
export function thinkingLevels(variants: readonly string[]): string[] {
  return [DEFAULT_VARIANT, ...variants.filter((variant) => variant !== DEFAULT_VARIANT)];
}

/** `provider/model`, the way OpenCode's config names a model. */
export function parseModelRef(value: string | undefined): OpenCodeModelRef | undefined {
  const text = value?.trim() ?? "";
  const at = text.indexOf("/");
  return at > 0 && at < text.length - 1 ? { provider: text.slice(0, at), id: text.slice(at + 1) } : undefined;
}

/**
 * The models a new thread may start on, from the providers OpenCode reports
 * connected. The first is what `model` in the config names, else OpenCode Zen's
 * default, else the first provider's default.
 */
export function openCodeNewThreadCatalog(list: OpenCodeProviderList, configured?: OpenCodeModelRef): HostRuntimeNewThreadCatalog {
  const providers = connectedProviders(list);
  const models = providers.flatMap((provider) => Object.values(provider.models).filter(usable).map((model) => catalogModel(provider, model)));
  if (models.length === 0) {
    return { models: [], thinkingLevels: {}, status: "sign-in-required", note: "OpenCode has no provider with a login or key. Run opencode auth login, then open the picker again." };
  }
  const find = (ref: OpenCodeModelRef | undefined) => ref ? models.find((model) => model.provider === ref.provider && model.id === ref.id) : undefined;
  const fallback = (id: string) => find({ provider: id, id: list.default[id] ?? "" });
  const start = find(configured) ?? fallback("opencode") ?? providers.map((provider) => fallback(provider.id)).find(Boolean) ?? models[0];
  const levels: Record<string, string[]> = {};
  for (const provider of providers) {
    for (const model of Object.values(provider.models).filter(usable)) levels[model.id] ??= thinkingLevels(variantsOf(model));
  }
  return { models, ...(start ? { model: start } : {}), thinkingLevels: levels };
}
