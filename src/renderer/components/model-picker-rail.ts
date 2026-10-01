import type { ThreadBackendKind, UiRuntimeBackend } from "../../shared/contracts";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { runtimeUpdate } from "../runtime-update";
import { MAKER_ORDER } from "./model-entries";

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

/** A runtime with its state as far as the picker knows it. */
export interface RuntimeEntry { backend: UiRuntimeBackend; status: RuntimeStatus; listed: boolean }

/**
 * One entry of the picker's rail: Favourites, Recent, every maker of a listed
 * model, then the runtimes that list none (not installed, signed out, or
 * listing once a thread runs on them).
 */
export type ViewEntry =
  | { kind: "favourites"; key: string }
  | { kind: "recent"; key: string }
  | { kind: "maker"; key: string; maker: string }
  | ({ kind: "runtime"; key: string } & RuntimeEntry);

export const makerView = (maker: string): string => `maker:${maker}`;
export const runtimeView = (kind: ThreadBackendKind): string => `runtime:${kind}`;

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

/** Every runtime the host offers, in its order; the one on hand first when the host names none. */
export function pickerRuntimes(catalogRuntime: ThreadBackendKind = DEFAULT_RUNTIME, backends: readonly UiRuntimeBackend[] | undefined, catalogs: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry>): RuntimeEntry[] {
  const offered = backends?.length ? [...backends] : [];
  if (!offered.some((backend) => backend.kind === catalogRuntime)) offered.unshift({ kind: catalogRuntime, label: catalogRuntime === DEFAULT_RUNTIME ? "Pi" : catalogRuntime });
  return offered.map((backend) => Object.assign({ backend }, runtimeStatus(backend, catalogs.get(backend.kind), backend.kind === catalogRuntime)));
}

/** The rail: known makers in their order, the other sets by name, then the runtimes that list nothing. */
export function pickerViews(makers: Iterable<string>, runtimes: readonly RuntimeEntry[], label: (maker: string) => string): ViewEntry[] {
  const rank = (maker: string) => { const at = MAKER_ORDER.indexOf(maker); return at < 0 ? MAKER_ORDER.length : at; };
  const sorted = [...new Set(makers)].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  return [
    { kind: "favourites", key: FAVOURITES_VIEW },
    { kind: "recent", key: RECENT_VIEW },
    ...sorted.map((maker): ViewEntry => ({ kind: "maker", key: makerView(maker), maker })),
    ...runtimes.filter((entry) => !entry.listed).map((entry): ViewEntry => Object.assign({ kind: "runtime" as const, key: runtimeView(entry.backend.kind) }, entry)),
  ];
}
