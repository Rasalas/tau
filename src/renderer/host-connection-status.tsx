import { useCallback, useSyncExternalStore } from "react";
import { useHostClient } from "./host-client-context";

const LABEL = {
  connected: "",
  reconnecting: "Reconnecting to the host…",
  resyncing: "Refetching the workbench state…",
} as const;

/** Visible only while the link to the host is not whole. */
export function HostConnectionStatus() {
  const client = useHostClient();
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined),
    [client],
  );
  const state = useSyncExternalStore(subscribe, () => client?.getConnectionState() ?? "connected");
  if (state === "connected") return null;
  return <div className={`host-connection-status ${state}`} role="status" aria-live="polite">{LABEL[state]}</div>;
}
