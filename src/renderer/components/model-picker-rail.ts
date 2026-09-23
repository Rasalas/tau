import type { ThreadBackendKind, UiRuntimeBackend } from "../../shared/contracts";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { runtimeUpdate } from "../runtime-update";

export const FAVOURITES_VIEW = "favourites";
export const RECENT_VIEW = "recent";

/** What the dot beside a runtime says. */
export type RuntimeStatus = "ready" | "update" | "loading" | "sign-in" | "not-installed" | "unavailable" | "unlisted";

export const RUNTIME_STATUS_LABELS: Record<RuntimeStatus, string> = {
  ready: "ready",
  update: "update available",
  loading: "asking for its models",
  "sign-in": "sign-in needed",
  "not-installed": "not installed",
  unavailable: "unavailable",
  unlisted: "models listed once a thread runs",
};

/** One entry of the picker's left column. */
export type ViewEntry =
  | { kind: "favourites"; key: string }
  | { kind: "recent"; key: string }
  | { kind: "runtime"; key: string; backend: UiRuntimeBackend; status: RuntimeStatus; listed: boolean };

export function runtimeView(kind: ThreadBackendKind): string {
  return `runtime:${kind}`;
}

/**
 * A runtime's state as far as the picker knows it: whether its models are on
 * hand, and if not why; a ready runtime with a newer or troubled program says so.
 */
export function runtimeStatus(backend: UiRuntimeBackend, entry: RuntimeCatalogEntry | undefined, onHand: boolean): { status: RuntimeStatus; listed: boolean } {
  const listed = onHand || (entry?.status === "ready" && entry.catalog.models.length > 0);
  if (listed) return { status: runtimeUpdate(backend) ? "update" : "ready", listed };
  if (entry?.status === "loading") return { status: "loading", listed };
  if (entry?.status === "unavailable") {
    if (entry.reason === "not-installed") return { status: "not-installed", listed };
    if (entry.reason === "sign-in-required") return { status: "sign-in", listed };
    return { status: entry.message ? "unavailable" : "unlisted", listed };
  }
  return { status: "unlisted", listed };
}

export interface ViewInput {
  /** The runtime the models on hand belong to. */
  catalogRuntime: ThreadBackendKind | undefined;
  /** Every runtime the host offers; absent on a host that offers only Pi. */
  backends: readonly UiRuntimeBackend[] | undefined;
  catalogs: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry>;
  recent: boolean;
}

/** Favourites, Recent when something was chosen before, then every runtime in the host's order. */
export function pickerViews({ catalogRuntime = DEFAULT_RUNTIME, backends, catalogs, recent }: ViewInput): ViewEntry[] {
  const offered = backends?.length ? [...backends] : [];
  if (!offered.some((backend) => backend.kind === catalogRuntime)) offered.unshift({ kind: catalogRuntime, label: catalogRuntime === DEFAULT_RUNTIME ? "Pi" : catalogRuntime });
  return [
    { kind: "favourites", key: FAVOURITES_VIEW },
    ...(recent ? [{ kind: "recent", key: RECENT_VIEW } as const] : []),
    ...offered.map((backend): ViewEntry => ({ kind: "runtime", key: runtimeView(backend.kind), backend, ...runtimeStatus(backend, catalogs.get(backend.kind), backend.kind === catalogRuntime) })),
  ];
}
