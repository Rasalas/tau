import { useCallback, useMemo, useSyncExternalStore } from "react";
import { READ_ONLY_REASON } from "../shared/host-method-access";
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

/** The reason a write control of a Read-only device gives, where it is disabled rather than left out (API 1.13.0). */
export { READ_ONLY_REASON };

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

/** The name the host gave in its hello (ADR 0025); undefined before it, or from a host that gives none. */
export function useHostName(): string | undefined {
  const client = useHostClient();
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined),
    [client],
  );
  const read = useCallback(() => client?.getHostName?.(), [client]);
  return useSyncExternalStore(subscribe, read, read);
}

/** For stores and other modules outside the component tree; defaults to the ambient client. */
export function hostHasLocalFiles(client: { hasCapability(capability: string): boolean } | undefined = getHostClient()): boolean {
  return client?.hasCapability(HOST_CAPABILITY.localFiles) ?? false;
}

/** Whether this device may only read, for code outside the component tree; defaults to the ambient client. */
export function hostIsReadOnly(client: { isReadOnly(): boolean } | undefined = getHostClient()): boolean {
  return client?.isReadOnly() ?? false;
}

type CommandGate = { isReadOnly(): boolean; mayInvokeHostExtension?(extensionId: string, command: string): boolean };

/**
 * Whether this device may run a kit's host command (API 1.13.0). On a device
 * paired Read only, only a command registered `access: "read"` is; disable the
 * control with `READ_ONLY_REASON` otherwise. A call it may not make is refused
 * before it is sent, with the same reason.
 */
export function useCommandAllowed(extensionId: string, command: string): boolean {
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => {
    const offState = client?.onConnectionState(listener);
    const offCommands = client?.onHostCommandsChanged?.(listener);
    return () => { offState?.(); offCommands?.(); };
  }, [client]);
  const read = useCallback(() => hostCommandAllowed(extensionId, command, client), [client, extensionId, command]);
  return useSyncExternalStore(subscribe, read, read);
}

/** `useCommandAllowed` for code outside the component tree; defaults to the ambient client. */
export function hostCommandAllowed(extensionId: string, command: string, client: CommandGate | undefined = getHostClient()): boolean {
  if (!client) return true;
  return client.mayInvokeHostExtension?.(extensionId, command) ?? !client.isReadOnly();
}

/**
 * Why a Read-only device may not run this command or palette row, or nothing
 * when it may: only what declares `access: "read"` runs there.
 */
export function commandRefusal(entry: { access?: "read" | "write"; unavailable?: () => string | undefined }, readOnly: boolean): string | undefined {
  return readOnly && entry.access !== "read" ? READ_ONLY_REASON : entry.unavailable?.();
}
