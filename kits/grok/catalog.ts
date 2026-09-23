import type { HostCatalogModel, HostRuntimeNewThreadCatalog, UiModelBilling } from "tau/host-extension";
import type { AcpStoredModel } from "../_acp/session-store.js";

/** xAI serves every model; Pi's model data prices them under this provider. */
export const MODEL_PROVIDER = "xai";
/** The effort picker's first entry: the model's own default. */
export const DEFAULT_EFFORT = "default";

/** A model as Grok's ACP server lists it; efforts and context ride in `_meta`. */
export interface GrokModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface GrokModelState {
  currentModelId: string;
  availableModels: GrokModelInfo[];
}

const EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A model state from `session/new`'s `models`, or from `initialize._meta.modelState`, which Grok sends before any session. */
export function modelStateOf(value: unknown): GrokModelState | undefined {
  const state = record(value);
  if (!state || typeof state.currentModelId !== "string" || !Array.isArray(state.availableModels)) return undefined;
  const availableModels = state.availableModels.flatMap((entry): GrokModelInfo[] => {
    const model = record(entry);
    const id = text(model?.modelId);
    return id ? [{ modelId: id, name: text(model?.name) ?? id, ...(record(model?.["_meta"]) ? { _meta: record(model?.["_meta"])! } : {}) }] : [];
  });
  return { currentModelId: state.currentModelId.trim(), availableModels };
}

export function initializeModelState(initialized: { _meta?: unknown } | undefined): GrokModelState | undefined {
  return modelStateOf(record(initialized?.["_meta"])?.modelState);
}

/** The reasoning efforts a model advertises, Grok's values; none when it says it has none. */
export function effortsOf(model: GrokModelInfo | undefined): string[] {
  const meta = model?.["_meta"];
  if (!meta || meta.supportsReasoningEffort === false || !Array.isArray(meta.reasoningEfforts)) return [];
  const seen = new Set<string>();
  return meta.reasoningEfforts.flatMap((entry) => {
    const option = record(entry);
    const value = [text(option?.value), text(option?.id)].find((candidate) => candidate && EFFORT_TOKEN.test(candidate));
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [value];
  });
}

/** The effort a session runs its model at, as the model state says. */
export function currentEffort(state: GrokModelState | undefined): string | undefined {
  const model = state?.availableModels.find((entry) => entry.modelId === state.currentModelId);
  const effort = text(model?.["_meta"]?.reasoningEffort);
  return effort && EFFORT_TOKEN.test(effort) ? effort : undefined;
}

export function thinkingLevels(efforts: readonly string[]): string[] {
  return [DEFAULT_EFFORT, ...efforts.filter((effort) => effort !== DEFAULT_EFFORT)];
}

/** `grok-4.6` → `Grok 4.6`, for a model only `grok models` named. */
export function modelName(id: string): string {
  return id.split(/[-_]/u).map((part) => part.toLowerCase() === "grok" ? "Grok" : part).join(" ");
}

export function storedModels(state: GrokModelState | undefined): AcpStoredModel[] {
  const seen = new Set<string>();
  return (state?.availableModels ?? []).flatMap((model) => {
    if (seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const context = model["_meta"]?.totalContextTokens;
    const contextWindow = typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? context : undefined;
    return [{ id: model.modelId, name: model.name, efforts: effortsOf(model), ...(contextWindow ? { contextWindow } : {}) }];
  });
}

/**
 * The models a new thread may start on. The CLI's own login is a Grok
 * subscription, an `XAI_API_KEY` the API; the host adds the API price of each
 * model where Pi's data knows it.
 */
export function grokNewThreadCatalog(models: readonly AcpStoredModel[], options: { billing: UiModelBilling; start?: string }): HostRuntimeNewThreadCatalog {
  if (models.length === 0) return { models: [], thinkingLevels: {}, status: "unavailable", note: "Grok named no models for this login." };
  const catalog: HostCatalogModel[] = models.map((model) => ({
    provider: MODEL_PROVIDER,
    id: model.id,
    name: model.name,
    billing: options.billing,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.efforts.length ? { reasoning: true } : {}),
  }));
  const start = catalog.find((model) => model.id === options.start) ?? catalog[0];
  return {
    models: catalog,
    ...(start ? { model: start } : {}),
    thinkingLevels: Object.fromEntries(models.map((model) => [model.id, thinkingLevels(model.efforts)])),
  };
}
