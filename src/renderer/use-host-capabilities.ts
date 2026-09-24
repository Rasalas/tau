import { useCallback, useMemo, useSyncExternalStore } from "react";
import { HOST_CAPABILITY } from "../shared/host-transport";
import { getHostClient, useHostClient } from "./host-client-context";

export interface HostCapabilities {
  /**
   * The host's files are files of this machine. Without it a path the host
   * reports means nothing here, so the workbench offers no editor, no "copy
   * path" and no reveal.
   */
  localFiles: boolean;
  /**
   * This device was paired Read only: the host refuses every call that
   * changes something (ADR 0024), so a write action is disabled with that
   * reason or left out (API 1.13.0).
   */
  readOnly: boolean;
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
  const readAccess = useCallback(() => client?.isReadOnly() ?? false, [client]);
  const localFiles = useSyncExternalStore(subscribe, read, read);
  const readOnly = useSyncExternalStore(subscribe, readAccess, readAccess);
  return useMemo(() => ({ localFiles, readOnly }), [localFiles, readOnly]);
}

/** For stores and other modules outside the component tree; defaults to the ambient client. */
export function hostHasLocalFiles(client: { hasCapability(capability: string): boolean } | undefined = getHostClient()): boolean {
  return client?.hasCapability(HOST_CAPABILITY.localFiles) ?? false;
}

/** Whether this device may only read, for code outside the component tree; defaults to the ambient client. */
export function hostIsReadOnly(client: { isReadOnly(): boolean } | undefined = getHostClient()): boolean {
  return client?.isReadOnly() ?? false;
}
