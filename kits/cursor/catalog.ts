import type { HostCatalogModel, HostRuntimeNewThreadCatalog } from "tau/host-extension";
import { modelProvider } from "../_acp/model-provider.js";
import { configOptionValues, type AcpConfigOption } from "../_acp/session.js";
import type { CursorStoredModel } from "./session-store.js";

/** Cursor serves every model itself and bills the Cursor plan; its own models (Auto, Composer) are this provider's. */
export const MODEL_PROVIDER = "cursor";

/** A model's provider: its maker's where the name tells, Cursor's otherwise. */
export function cursorModelProvider(model: { id: string; name?: string }): string {
  return modelProvider(model, MODEL_PROVIDER);
}
/** The effort picker's first entry: the model's own default. */
export const DEFAULT_EFFORT = "default";
/** Cursor's automatic choice, the model a new thread gets when nobody picks one. */
const AUTO_MODEL = "default";

/** One entry of `cursor/list_available_models`. */
export interface CursorListedModel {
  value: string;
  name: string;
  configOptions?: AcpConfigOption[] | null;
}

function isEffortOption(option: AcpConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "effort" || id === "reasoning" || name.includes("effort") || name.includes("reasoning");
}

/** The select that holds a model's reasoning effort; Cursor has put it under several ids and categories. */
export function effortOption(options: readonly AcpConfigOption[] | null | undefined): AcpConfigOption | undefined {
  const candidates = (options ?? []).filter((option) => option.type === "select" && isEffortOption(option));
  return candidates.find((option) => option.category === "model_option")
    ?? candidates.find((option) => option.id.trim().toLowerCase() === "effort")
    ?? candidates.find((option) => option.category === "thought_level")
    ?? candidates[0];
}

export function effortsOf(options: readonly AcpConfigOption[] | null | undefined): string[] {
  return configOptionValues(effortOption(options)).map((entry) => entry.value.trim()).filter(Boolean);
}

/** The levels a model offers: its own default first, then Cursor's efforts. */
export function thinkingLevels(efforts: readonly string[]): string[] {
  return [DEFAULT_EFFORT, ...efforts.filter((effort) => effort !== DEFAULT_EFFORT)];
}

export function storedModels(listed: readonly CursorListedModel[]): CursorStoredModel[] {
  const seen = new Set<string>();
  return listed.flatMap((model) => {
    const id = typeof model.value === "string" ? model.value.trim() : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id, efforts: effortsOf(model.configOptions) }];
  });
}

/**
 * The models a new thread may start on. Every offer is the Cursor plan's; the
 * host adds the API price of the same model where Pi's data knows it.
 */
export function cursorNewThreadCatalog(models: readonly CursorStoredModel[]): HostRuntimeNewThreadCatalog {
  if (models.length === 0) return { models: [], thinkingLevels: {}, status: "unavailable", note: "Cursor named no models for this account." };
  const catalog: HostCatalogModel[] = models.map((model) => ({
    provider: cursorModelProvider(model),
    id: model.id,
    name: model.name,
    billing: "subscription",
    ...(model.efforts.length ? { reasoning: true } : {}),
  }));
  const start = catalog.find((model) => model.id === AUTO_MODEL) ?? catalog[0];
  return {
    models: catalog,
    ...(start ? { model: start } : {}),
    thinkingLevels: Object.fromEntries(models.map((model) => [model.id, thinkingLevels(model.efforts)])),
  };
}
