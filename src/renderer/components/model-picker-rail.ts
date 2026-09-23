import type { ThreadBackendKind, UiRuntimeBackend } from "../../shared/contracts";
import { DEFAULT_RUNTIME } from "../runtime-marks";

export const FAVOURITES_ENTRY = "\u0000favourites";

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * One tab of the picker's rail. Pi's catalog is split by model provider when
 * it is the catalog on hand; any other runtime is one tab, whose models are
 * listed (`listed`) when they are on hand or the host's cache holds them.
 */
export type RailEntry =
  | { kind: "favourites"; key: string }
  | { kind: "provider"; key: string; provider: string }
  | { kind: "runtime"; key: string; backend: UiRuntimeBackend; listed: boolean };

export interface RailInput {
  /** Model providers of the catalog on hand, sorted. */
  providers: readonly string[];
  /** The runtime that catalog belongs to. */
  catalogRuntime: ThreadBackendKind | undefined;
  /** Every runtime the host offers, Pi first; absent on a host that offers only Pi. */
  backends: readonly UiRuntimeBackend[] | undefined;
  favourites: boolean;
  /** Runtimes besides the catalog's own whose models the host's cache holds. */
  cached?: ReadonlySet<ThreadBackendKind>;
}

export function runtimeEntryKey(kind: ThreadBackendKind): string {
  return `runtime:${kind}`;
}

export function pickerRail({ providers, catalogRuntime = DEFAULT_RUNTIME, backends, favourites, cached }: RailInput): RailEntry[] {
  const offered = backends?.length ? [...backends] : [];
  if (!offered.some((backend) => backend.kind === catalogRuntime)) offered.unshift({ kind: catalogRuntime, label: catalogRuntime === DEFAULT_RUNTIME ? "Pi" : catalogRuntime });
  const rail: RailEntry[] = favourites ? [{ kind: "favourites", key: FAVOURITES_ENTRY }] : [];
  for (const backend of offered) {
    const own = backend.kind === catalogRuntime;
    const listed = own || cached?.has(backend.kind) === true;
    if (own && backend.kind === DEFAULT_RUNTIME && providers.length > 0) {
      rail.push(...providers.map((provider): RailEntry => ({ kind: "provider", key: provider, provider })));
    } else {
      rail.push({ kind: "runtime", key: runtimeEntryKey(backend.kind), backend, listed });
    }
  }
  return rail;
}

/** The tab a model of the catalog on hand lives under. */
export function railKeyForModel(provider: string, catalogRuntime: ThreadBackendKind | undefined): string {
  return (catalogRuntime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME ? provider : runtimeEntryKey(catalogRuntime as string);
}
