import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { versionSkew } from "../shared/app-version";
import { compareVersions } from "../shared/runtime-version";
import type { HostConnectionState } from "../workbench/host-connection";
import type { HostLink } from "../workbench/host-link";
import type { HostClient } from "../workbench/host-client";
import { ConnectionTimers } from "../shared/connection-timers";
import { useHostClient } from "./host-client-context";
import { useHostCapabilities } from "./use-host-capabilities";
import { tooltipProps } from "./components/ui/Tooltip";
import { chunkRecovery } from "./chunk-reload";
import { useClientEnvironment } from "./client-environment";
import { UpdateHostButton, UpdateWindowButton } from "./deferred-surfaces";

const LABEL = {
  connected: "",
  reconnecting: "Reconnecting to the host…",
  resyncing: "Updating your workspace…",
  refused: "Tau refused the connection to the host",
} as const;

/** A round trip above this reads as a slow link. */
const SLOW_ROUND_TRIP_MS = 1_000;
/** A normal wake or a brief link repair should not move the conversation. */
const CONNECTION_NOTICE_DELAY_MS = 5_000;

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
    return <ConnectionRepairNotice client={client} state={state} link={link} />;
  }
  return <VersionSkewNotice />;
}

/** Keeps one grace period across reconnect and resync; a healthy link unmounts it. */
function ConnectionRepairNotice({ client, state, link }: {
  client: HostClient | undefined;
  state: "reconnecting" | "resyncing";
  link: HostLink | undefined;
}) {
  const [visibleFor, setVisibleFor] = useState<HostClient>();
  useEffect(() => {
    const timers = new ConnectionTimers();
    timers.after(CONNECTION_NOTICE_DELAY_MS, () => setVisibleFor(client));
    return () => timers.close();
  }, [client]);
  if (!client || visibleFor !== client) return null;
  const offline = state === "reconnecting" && link?.phase === "offline";
  const waiting = state === "reconnecting" && (link?.phase === "waiting" || offline);
  return <div className={`host-connection-status connection-repair ${state}`} role="status" aria-live="polite">
    <span className="host-connection-message">
      {offline ? null : <span className="spinner tone-current small" aria-hidden="true" />}
      <span>{offline ? "You're offline. Tau will reconnect automatically." : state === "resyncing" ? LABEL.resyncing : "Restoring connection…"}</span>
    </span>
    {state === "reconnecting" && link ? <button type="button" className="text-button" disabled={!waiting} onClick={() => client.reconnectNow()}>Retry now</button> : null}
  </div>;
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
    {windowBehind ? <UpdateWindowButton /> : <UpdateHostButton />}
  </div>;
}
