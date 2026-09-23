import { useEffect, useSyncExternalStore } from "react";
import type { ThreadBackendKind } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { RuntimeCatalogStore, type RuntimeCatalogEntry } from "../workbench/runtime-catalog-store";
import { useHostClient } from "./host-client-context";

const stores = new WeakMap<HostClient, RuntimeCatalogStore>();
const idle = () => () => undefined;

/** What `kind` offers a thread that does not exist yet; asked of the host while a draft is bound for it. */
export function useRuntimeCatalog(kind: ThreadBackendKind | undefined): RuntimeCatalogEntry | undefined {
  const client = useHostClient();
  let store = client ? stores.get(client) : undefined;
  if (client && !store) stores.set(client, store = new RuntimeCatalogStore((runtime) => client.runtimeCatalog(runtime)));
  useEffect(() => { if (kind) store?.request(kind); }, [kind, store]);
  return useSyncExternalStore(store?.subscribe ?? idle, () => (kind ? store?.get(kind) : undefined));
}
