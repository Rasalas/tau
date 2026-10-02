import { useCallback, useMemo, useSyncExternalStore } from "react";
import { versionSkew } from "../shared/app-version";
import { hostUpdatePending } from "../shared/host-updates";
import { compareVersions } from "../shared/runtime-version";
import type { HostConnectionState } from "../workbench/host-connection";
import type { HostLink } from "../workbench/host-link";
import type { HostClient } from "../workbench/host-client";
import { useHostClient } from "./host-client-context";
import { useHostCapabilities } from "./use-host-capabilities";
import { tooltipProps } from "./components/ui/Tooltip";
import { chunkRecovery } from "./chunk-reload";
import { useClientEnvironment } from "./client-environment";
import { hostUpdateStore } from "../workbench/host-update-store";
import { useAppUpdate } from "./renderer-services-context";

const LABEL = {
  connected: "",
  reconnecting: "Reconnecting to the host…",
  resyncing: "Refetching the workbench state…",
  refused: "Tau refused the connection to the host",
} as const;

/** A round trip above this reads as a slow link. */
const SLOW_ROUND_TRIP_MS = 1_000;

function useConnectionState(client: HostClient | undefined): HostConnectionState {
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined),
    [client],
  );
  return useSyncExternalStore(subscribe, () => client?.getConnectionState() ?? "connected");
}

function useConnectionLink(client: HostClient | undefined): HostLink | undefined {
  const subscribe = useCallback(
    (listener: () => void) => client?.onConnectionLink(listener) ?? (() => undefined),
    [client],
  );
  return useSyncExternalStore(subscribe, () => client?.getConnectionLink());
}

export type HostLinkTone = "ok" | "slow" | "pending" | "offline" | "refused";

/** What the indicator says about the link, from the connection's state and the socket's. */
export function describeHostLink(state: HostConnectionState, link: HostLink): { tone: HostLinkTone; label: string } {
  if (state === "refused" || link.phase === "closed") return { tone: "refused", label: LABEL.refused };
  if (link.phase === "offline") return { tone: "offline", label: "Offline. Tau reconnects when the network is back." };
  if (state === "resyncing") return { tone: "pending", label: LABEL.resyncing };
  if (state === "reconnecting" || link.phase !== "open") return { tone: "pending", label: LABEL.reconnecting };
  const roundTrip = link.roundTripMs;
  if (roundTrip === undefined) return { tone: "ok", label: "Connected to the host" };
  const shown = roundTrip < 1_000 ? `${roundTrip} ms` : `${(roundTrip / 1_000).toFixed(1)} s`;
  return roundTrip > SLOW_ROUND_TRIP_MS
    ? { tone: "slow", label: `Slow connection to the host, ${shown} round trip` }
    : { tone: "ok", label: `Connected to the host, ${shown} round trip` };
}

/**
 * A dot in the title bar for a host on another machine: how the link is,
 * in its tooltip. A click checks the link, or tries now instead of waiting.
 */
export function HostLinkIndicator() {
  const client = useHostClient();
  const state = useConnectionState(client);
  const link = useConnectionLink(client);
  const { localFiles } = useHostCapabilities();
  // The window's own host is on this machine; its link is not worth a glance.
  if (!client || !link || localFiles) return null;
  const { tone, label } = describeHostLink(state, link);
  return <button
    type="button"
    className={`chrome-ghost glyph host-link-indicator ${tone}`}
    aria-label={label}
    {...tooltipProps(label, { side: "bottom" })}
    onClick={() => client.reconnectNow()}
  ><span className="host-link-dot" aria-hidden /></button>;
}

/** Visible only while the link to the host is not whole, or while both ends run different builds. */
export function HostConnectionStatus() {
  const client = useHostClient();
  const state = useConnectionState(client);
  const link = useConnectionLink(client);
  if (state === "refused") {
    // Final, not a transient repair: an alert, and the reason in full.
    return <div className="host-connection-status refused" role="alert">
      <strong>{LABEL.refused}</strong>
      <span className="host-connection-detail">{client?.getConnectionRefusal() ?? ""}</span>
    </div>;
  }
  if (state !== "connected") {
    const waiting = state === "reconnecting" && (link?.phase === "waiting" || link?.phase === "offline");
    return <div className={`host-connection-status ${state}`} role="status" aria-live="polite">
      <span>{link?.phase === "offline" && state === "reconnecting" ? "Offline. Tau reconnects when the network is back." : LABEL[state]}</span>
      {waiting ? <button type="button" className="text-button" onClick={() => client?.reconnectNow()}>Retry now</button> : null}
    </div>;
  }
  return <VersionSkewNotice />;
}

/** The host's version when this page first heard from it. */
const firstHostVersion = new WeakMap<HostClient, string>();

/**
 * The page's code came from the host, and the host now runs another version:
 * its chunks are gone, so the page offers to reload. Undefined until then.
 */
export function hostUpdatedTo(client: HostClient, hostVersion: string | undefined): string | undefined {
  if (!hostVersion) return undefined;
  const first = firstHostVersion.get(client);
  if (first === undefined) firstHostVersion.set(client, hostVersion);
  return first !== undefined && first !== hostVersion ? hostVersion : undefined;
}

/** The window's process and the host process report different Tau versions (ADR 0021). */
function VersionSkewNotice() {
  const { servedByHost } = useClientEnvironment();
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => client?.onVersions(listener) ?? (() => undefined), [client]);
  // A string, so the snapshot is stable between reads.
  const pair = useSyncExternalStore(subscribe, () => {
    const versions = client?.getVersions();
    return `${versions?.window ?? ""}\n${versions?.host ?? ""}`;
  });
  const [windowVersion, hostVersion] = pair.split("\n");
  if (servedByHost && client && hostUpdatedTo(client, hostVersion)) {
    return <div className="host-connection-status version-skew" role="status">
      <span><strong>Tau was updated.</strong> Reload to continue.</span>
      <button type="button" className="text-button" onClick={() => chunkRecovery.reload()}>Reload</button>
    </div>;
  }
  const skew = versionSkew(windowVersion, hostVersion);
  if (!skew) return null;
  const windowBehind = compareVersions(skew.window, skew.host) < 0;
  return <div className="host-connection-status version-skew" role="status">
    <span>
      <strong>Version mismatch.</strong> This window runs Tau {skew.window}, its host runs {skew.host}.
    </span>
    {windowBehind ? <UpdateWindow /> : <UpdateHost />}
  </div>;
}

const progress = (phase: string | undefined, percent: number | undefined) => phase === "downloading" ? `Downloading${percent === undefined ? "…" : ` ${percent}%`}`
  : phase === "waiting" ? "Waiting for turns…" : phase === "installing" ? "Installing…" : phase === "checking" ? "Checking…" : undefined;

/** The window's own Tau: restart into a downloaded release, or ask its updater, which reports what it found. */
function UpdateWindow() {
  const client = useHostClient();
  const update = useAppUpdate();
  return update
    ? <button type="button" className="text-button" disabled={Boolean(update.phase)} onClick={() => update.install()}>{progress(update.phase, update.progress) ?? `Restart to update to ${update.version}`}</button>
    : <button type="button" className="text-button" onClick={() => void client?.windowAction({ kind: "check-for-updates" }).catch(() => undefined)}>Check for updates</button>;
}

/** The host's own Tau through its updater (K103); a failure comes back as its status. */
function UpdateHost() {
  const client = useHostClient();
  const store = useMemo(() => (client ? hostUpdateStore(client) : undefined), [client]);
  const status = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), () => store?.getSnapshot().status);
  if (!status || !store || status.phase === "unsupported") return null;
  const pending = hostUpdatePending(status);
  const refused = client?.isReadOnly() || (pending && !client?.isOwner?.() && !status.devicesMayInstall);
  const busy = progress(status.phase, status.progress);
  return <button
    type="button"
    className="text-button"
    disabled={Boolean(busy || refused)}
    {...tooltipProps(refused ? "Only a device with Full access may update this host." : status.phase === "failed" ? status.reason : undefined)}
    onClick={() => void (pending ? store.install() : store.check()).catch(() => undefined)}
  >{busy ?? (pending ? "Update host" : "Check for updates")}</button>;
}
