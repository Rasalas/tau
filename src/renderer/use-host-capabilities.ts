import { useCallback, useMemo, useSyncExternalStore } from "react";
import { HOST_CAPABILITY } from "../shared/host-transport";
import { useHostClient } from "./host-client-context";

export interface HostCapabilities {
  /**
   * The host's files are files of this machine. Without it a path the host
   * reports means nothing here, so the workbench offers no editor, no "copy
   * path" and no reveal.
   */
  localFiles: boolean;
}

/** What the connected host announced in its hello. */
export function useHostCapabilities(): HostCapabilities {
  const client = useHostClient();
  // Capabilities are settled by the hello and can only change with the
  // connection, so its state is what this re-reads on.
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined),
    [client],
  );
  const read = useCallback(() => client?.hasCapability(HOST_CAPABILITY.localFiles) ?? false, [client]);
  const localFiles = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => ({ localFiles }), [localFiles]);
}

/** For stores and other modules outside the component tree. */
export function hostHasLocalFiles(client: { hasCapability(capability: string): boolean } | undefined): boolean {
  return client?.hasCapability(HOST_CAPABILITY.localFiles) ?? false;
}
