import { useMemo, useSyncExternalStore } from "react";
import type { ExtensionRegistry } from "./extension-system";

/** Follow only the extension data this view reads. */
export function useExtensionData(registry: ExtensionRegistry | undefined, key: string): number {
  const subscription = useMemo(() => ({
    subscribe: (listener: () => void) => registry?.subscribeData(key, listener) ?? (() => {}),
    snapshot: () => registry?.getDataVersion(key) ?? 0,
  }), [registry, key]);
  return useSyncExternalStore(subscription.subscribe, subscription.snapshot);
}
