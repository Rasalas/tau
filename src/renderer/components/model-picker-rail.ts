import type { ThreadBackendKind, UiRuntimeBackend } from "../../shared/contracts";
import { DEFAULT_RUNTIME } from "../runtime-marks";

export const FAVOURITES_ENTRY = "\u0000favourites";

/**
 * One tab of the picker's rail. Pi's catalog is split by model provider; any
 * other runtime is one tab, whose models are listed only when the catalog on
 * hand is its own (`listed`), because a runtime's models are known once a
 * thread of it runs.
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
}

export function runtimeEntryKey(kind: ThreadBackendKind): string {
  return `runtime:${kind}`;
}

export function pickerRail({ providers, catalogRuntime = DEFAULT_RUNTIME, backends, favourites }: RailInput): RailEntry[] {
  const offered = backends?.length ? [...backends] : [];
  if (!offered.some((backend) => backend.kind === catalogRuntime)) offered.unshift({ kind: catalogRuntime, label: catalogRuntime === DEFAULT_RUNTIME ? "Pi" : catalogRuntime });
  const rail: RailEntry[] = favourites ? [{ kind: "favourites", key: FAVOURITES_ENTRY }] : [];
  for (const backend of offered) {
    const listed = backend.kind === catalogRuntime;
    if (listed && backend.kind === DEFAULT_RUNTIME && providers.length > 0) {
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
