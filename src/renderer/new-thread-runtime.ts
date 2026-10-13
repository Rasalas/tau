import type { HostSnapshot, ThreadBackendKind, UiModel, UiRuntimeBackend, UiRuntimeCatalog } from "../shared/contracts";
import type { NewThreadSelection } from "../workbench/new-thread-controller";
import { catalogLevels, type RuntimeCatalogEntry } from "../workbench/runtime-catalog-store";
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

/** What the host has named so far for each runtime; a runtime it has not answered for is absent. */
export type RuntimeCatalogs = ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry>;

/** Whether a runtime can start a thread, as far as its catalog says; `undefined` until the host has answered. */
export type RuntimeStart = "ready" | "signed-out" | "not-installed" | "unavailable";

export function runtimeStart(kind: ThreadBackendKind, entry: RuntimeCatalogEntry | undefined): RuntimeStart | undefined {
  const catalog = entry && entry.status !== "loading" ? entry.catalog : undefined;
  if (!catalog) return undefined;
  if (catalog.models.length > 0) return "ready";
  if (catalog.status === "sign-in-required") return "signed-out";
  if (catalog.status === "not-installed") return "not-installed";
  if (catalog.status) return "unavailable";
  // Pi without a model has no provider; another runtime may name its models only once a thread runs.
  return kind === "pi" ? "signed-out" : "ready";
}

/** `runtimeStart`, but the thread on screen knows its own runtime better than a catalog that may be hours old. */
function startOf(kind: ThreadBackendKind, snapshot: HostSnapshot | undefined, catalogs: RuntimeCatalogs): RuntimeStart | undefined {
  if (snapshot?.sessionId && kind === (snapshot.backendKind ?? "pi") && snapshot.models?.length) return "ready";
  return runtimeStart(kind, catalogs.get(kind));
}

/**
 * The runtimes a new thread can start on, for a screen that says what is set up
 * (API 1.61.0). Nothing before every runtime the project offers has answered,
 * so "none is ready" is never claimed on a half-filled list.
 */
export function readyRuntimes(snapshot: HostSnapshot | undefined, catalogs: RuntimeCatalogs): UiRuntimeBackend[] | undefined {
  // A host that lists no backends has Pi alone.
  const offered = snapshot?.runtimeBackends?.length ? offeredBackends(snapshot.runtimeBackends) : [{ kind: "pi", label: "Pi" }];
  const ready = offered.filter((backend) => startOf(backend.kind, snapshot, catalogs) === "ready");
  const answered = offered.every((backend) => { const entry = catalogs.get(backend.kind); return entry !== undefined && entry.status !== "loading"; });
  return ready.length > 0 || answered ? ready : undefined;
}

/** The first runtime a project offers that is known to start a thread, when the host's default is known not to. */
function readyStandIn(snapshot: HostSnapshot | undefined, catalogs: RuntimeCatalogs | undefined): ThreadBackendKind | undefined {
  if (!catalogs) return undefined;
  const standard = snapshot?.defaultBackendKind ?? "pi";
  const start = startOf(standard, snapshot, catalogs);
  if (start === undefined || start === "ready") return undefined;
  return offeredBackends(snapshot?.runtimeBackends).find((backend) => startOf(backend.kind, snapshot, catalogs) === "ready")?.kind;
}

/**
 * The backend a new thread is created on: the client's choice when the host
 * offers it, else the first runtime that is ready when the host's default
 * cannot run a thread, else nothing, which leaves the host's default in charge.
 */
export function chosenNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined, catalogs?: RuntimeCatalogs): ThreadBackendKind | undefined {
  if (preference && snapshot?.runtimeBackends?.some((backend) => backend.kind === preference && !backend.disabled)) return preference;
  return readyStandIn(snapshot, catalogs);
}

/** The backends a new thread may start on: those the project on screen did not turn off. */
export function offeredBackends(backends: readonly UiRuntimeBackend[] | undefined): UiRuntimeBackend[] {
  return (backends ?? []).filter((backend) => !backend.disabled);
}

/** What the workbench shows as the runtime of the next new thread. */
export function effectiveNewThreadRuntime(preference: string | undefined, snapshot: HostSnapshot | undefined, catalogs?: RuntimeCatalogs): ThreadBackendKind {
  const standard = snapshot?.defaultBackendKind ?? "pi";
  const chosen = chosenNewThreadRuntime(preference, snapshot, catalogs);
  if (chosen) return chosen;
  // The host's default may be off in this project; the first runtime that is on stands in for it.
  return snapshot?.runtimeBackends?.some((backend) => backend.kind === standard && backend.disabled) ? offeredBackends(snapshot.runtimeBackends)[0]?.kind ?? standard : standard;
}

/** Why a new thread on `runtime` cannot start yet, when the catalogs say so. */
export type NewThreadSetup =
  /** No runtime the project offers can start a thread. */
  | { state: "none" }
  | { state: "signed-out" | "not-installed"; backend: UiRuntimeBackend };

/**
 * What stops a draft on `runtime` from being sent. Only what the catalogs
 * state outright counts: a runtime that has not answered, or failed to, never blocks.
 */
export function newThreadSetup(runtime: ThreadBackendKind, snapshot: HostSnapshot | undefined, catalogs: RuntimeCatalogs | undefined): NewThreadSetup | undefined {
  if (!catalogs) return undefined;
  const start = startOf(runtime, snapshot, catalogs);
  if (start !== "signed-out" && start !== "not-installed") return undefined;
  const offered = offeredBackends(snapshot?.runtimeBackends);
  const kinds = offered.length ? offered.map((backend) => backend.kind) : [runtime];
  if (kinds.every((kind) => { const state = startOf(kind, snapshot, catalogs); return state === "signed-out" || state === "not-installed"; })) return { state: "none" };
  const backend = offered.find((candidate) => candidate.kind === runtime) ?? { kind: runtime, label: runtime === "pi" ? "Pi" : runtime };
  return { state: start, backend };
}
