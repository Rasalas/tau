import { useCallback, useState, useSyncExternalStore } from "react";
import { versionSkew } from "../shared/app-version";
import { useHostClient } from "./host-client-context";

const LABEL = {
  connected: "",
  reconnecting: "Reconnecting to the host…",
  resyncing: "Refetching the workbench state…",
  refused: "Tau refused the connection to the host",
} as const;

/** Visible only while the link to the host is not whole, or while both ends run different builds. */
export function HostConnectionStatus() {
  const client = useHostClient();
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined),
    [client],
  );
  const state = useSyncExternalStore(subscribe, () => client?.getConnectionState() ?? "connected");
  if (state === "refused") {
    // Final, not a transient repair: an alert, and the reason in full.
    return <div className="host-connection-status refused" role="alert">
      <strong>{LABEL.refused}</strong>
      <span className="host-connection-detail">{client?.getConnectionRefusal() ?? ""}</span>
    </div>;
  }
  if (state !== "connected") return <div className={`host-connection-status ${state}`} role="status" aria-live="polite">{LABEL[state]}</div>;
  return <VersionSkewNotice />;
}

/** The window's process and the host process report different Tau versions (ADR 0021). */
function VersionSkewNotice() {
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => client?.onVersions(listener) ?? (() => undefined), [client]);
  // A string, so the snapshot is stable between reads.
  const pair = useSyncExternalStore(subscribe, () => {
    const versions = client?.getVersions();
    return `${versions?.window ?? ""}\n${versions?.host ?? ""}`;
  });
  const [dismissed, setDismissed] = useState<string>();
  const [windowVersion, hostVersion] = pair.split("\n");
  const skew = versionSkew(windowVersion, hostVersion);
  if (!skew || dismissed === pair) return null;
  return <div className="host-connection-status version-skew" role="status">
    <span>
      <strong>Version mismatch.</strong> This window runs Tau {skew.window}, its host runs {skew.host}.
      Bring both to the same version; until then, something one side added may not work.
    </span>
    <button type="button" className="text-button" onClick={() => setDismissed(pair)}>Dismiss</button>
  </div>;
}
