import type { HostSnapshot, ThreadBackendKind, UiModel, UiRuntimeCatalog } from "../shared/contracts";
import type { NewThreadSelection } from "../workbench/new-thread-controller";
import { catalogLevels } from "../workbench/runtime-catalog-store";
import { offeringKey } from "./components/model-offerings";

/** This runtime's picker history, newest first; Pi's keys have no runtime prefix. */
export function recentRuntimeModels(runtime: string, recent: readonly string[]): readonly string[] {
  return recent.filter((key) => runtime === "pi" ? !key.includes(":") : key.startsWith(`${runtime}:`));
}

/** A remembered choice that this host still offers, else its new-thread default. */
export function rememberedNewThreadSelection(catalog: UiRuntimeCatalog, recent: readonly string[], levels: Readonly<Record<string, string>>): NewThreadSelection | undefined {
  const keys = recentRuntimeModels(catalog.kind, recent);
  if (!keys.length) return undefined;
  const models = new Map(catalog.models.map((model) => [offeringKey(catalog.kind, model), model]));
  const model: UiModel | undefined = keys.map((key) => models.get(key)).find(Boolean) ?? catalog.model;
  if (!model) return undefined;
  const level = levels[offeringKey(catalog.kind, model)];
  return { runtime: catalog.kind, model, ...(level && catalogLevels(catalog, model).includes(level) ? { thinkingLevel: level } : {}) };
}

/**
 * The backend a new thread is created on: the client's choice when the host
 * offers it, else nothing, which leaves the host's default in charge.
 */
export function chosenNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined): ThreadBackendKind | undefined {
  if (!preference) return undefined;
  return snapshot?.runtimeBackends?.some((backend) => backend.kind === preference) ? preference : undefined;
}

/** What the workbench shows as the runtime of the next new thread. */
export function effectiveNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined): ThreadBackendKind {
  return chosenNewThreadRuntime(preference, snapshot) ?? snapshot?.defaultBackendKind ?? "pi";
}
