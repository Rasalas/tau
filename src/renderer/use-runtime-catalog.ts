import { useEffect, useSyncExternalStore } from "react";
import type { ThreadBackendKind } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { RuntimeCatalogStore, type RuntimeCatalogEntry } from "../workbench/runtime-catalog-store";
import { useHostClient } from "./host-client-context";

const stores = new WeakMap<HostClient, RuntimeCatalogStore>();
const idle = () => () => undefined;
const NONE: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> = new Map();

/** One store per client, following the host's catalog events for as long as the client lives. */
export function runtimeCatalogStore(client: HostClient | undefined): RuntimeCatalogStore | undefined {
  if (!client) return undefined;
  let store = stores.get(client);
  if (!store) {
    const created = store = new RuntimeCatalogStore(client);
    client.onHostEvent((event) => { if (event.type === "runtime-catalog") created.apply(event.catalog); });
    stores.set(client, store);
  }
  return store;
}

/** What `kind` offers a thread that does not exist yet; asked of the host while a draft is bound for it. */
export function useRuntimeCatalog(kind: ThreadBackendKind | undefined): RuntimeCatalogEntry | undefined {
  const store = runtimeCatalogStore(useHostClient());
  useEffect(() => { if (kind) store?.request(kind); }, [kind, store]);
  return useSyncExternalStore(store?.subscribe ?? idle, () => (kind ? store?.get(kind) : undefined));
}

/**
 * Every runtime's catalog while `open` (a picker is open): opening fetches what
 * is missing and has the host revalidate; closed, nothing re-renders for them.
 */
export function useRuntimeCatalogs(open: boolean): ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> {
  const client = useHostClient();
  const store = open ? runtimeCatalogStore(client) : undefined;
  useEffect(() => { void store?.refresh(); }, [store]);
  return useSyncExternalStore(store?.subscribe ?? idle, () => store?.all() ?? NONE);
}

/**
 * A model's name as its runtime's catalog lists it (API 1.23.0): asks for that
 * catalog once, and answers nothing until it is in or where it has no such model.
 */
export function useModelName(kind: ThreadBackendKind | undefined, model: string | undefined, provider?: string): string | undefined {
  const entry = useRuntimeCatalog(model ? kind : undefined);
  const models = entry && entry.status !== "loading" ? entry.catalog?.models : undefined;
  if (!model || !models) return undefined;
  return (models.find((item) => item.id === model && (!provider || item.provider === provider)) ?? models.find((item) => item.id === model))?.name;
}
