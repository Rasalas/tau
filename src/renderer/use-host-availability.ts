import { useCallback, useSyncExternalStore } from "react";
import type { HostHalf } from "../workbench/read-only-guard";
import { getHostClient, useHostClient } from "./host-client-context";

/** Whether an extension's host half runs, and if not, why, written for a tooltip. */
export interface HostAvailability {
  available: boolean;
  reason?: string;
}

type HalfSource = { hostExtensionHalf?(extensionId: string): HostHalf | null | undefined };

const AVAILABLE: HostAvailability = Object.freeze({ available: true });
const cache = new Map<string, HostAvailability>();

/** One object per answer, so `useSyncExternalStore` sees no change when nothing changed. */
function answer(reason: string | undefined): HostAvailability {
  if (!reason) return AVAILABLE;
  let known = cache.get(reason);
  if (!known) {
    known = Object.freeze({ available: false, reason });
    cache.set(reason, known);
  }
  return known;
}

/**
 * Whether the host half of `extensionId` runs (K112). A desktop half whose
 * controls call its host half disables them with `reason` instead of drawing
 * buttons that do nothing: not approved yet, failed to start (a permission it
 * lacks), stopped after failing. Until the host has answered it counts as
 * available, so nothing flickers off at startup.
 */
export function hostAvailability(extensionId: string, client: HalfSource | undefined = getHostClient()): HostAvailability {
  const half = client?.hostExtensionHalf?.(extensionId);
  if (half === undefined) return AVAILABLE;
  if (half === null) return answer("Its host half is not running. Settings → Extensions says why.");
  if (half.error) return answer(`Its host half stopped: ${half.error}.`);
  if (!half.active) return answer("Its host half is off: it waits for approval, or was turned off, in Settings → Extensions.");
  return AVAILABLE;
}

/** `hostAvailability` for a component: it draws again when the host's answer changes. */
export function useHostAvailability(extensionId: string): HostAvailability {
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => {
    const offState = client?.onConnectionState(listener);
    const offCommands = client?.onHostCommandsChanged?.(listener);
    return () => { offState?.(); offCommands?.(); };
  }, [client]);
  const read = useCallback(() => hostAvailability(extensionId, client), [client, extensionId]);
  return useSyncExternalStore(subscribe, read, read);
}
