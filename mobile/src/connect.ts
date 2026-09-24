import { createSocketHostClient } from "../../src/workbench/host-connection-socket";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostConnection } from "../../src/workbench/host-connection";
import type { HostWakeSource } from "../../src/workbench/host-link";
import { RacingSocket, socketCandidates, type DeviceNetwork, type SocketCandidate } from "./endpoints";
import type { SavedHost } from "./hosts";
import { NativeSocket, type SocketBridge } from "./native-socket";

export interface ConnectDependencies {
  bridge: SocketBridge;
  device: DeviceNetwork;
  wakes?: HostWakeSource;
  /** What the phone tells the host about itself; the web view's own, so the host sees a phone. */
  userAgent?: string;
}

export interface ConnectCallbacks {
  /** Another address won this time (home Wi-Fi, then Tailscale on the way out). */
  onAddress?(candidate: SocketCandidate): void;
  /** The host refused the token: revoked, or it ran out unused. `reason` is the close reason. */
  onUnauthorized(reason: string): void;
  /** Every address showed another certificate than the pinned one. */
  onCertificateMismatch(): void;
}

/** A pinned native socket for one candidate address. */
export function openCandidate(dependencies: Pick<ConnectDependencies, "bridge" | "userAgent">, candidate: SocketCandidate): NativeSocket {
  return new NativeSocket(dependencies.bridge, candidate.url, {
    ...(candidate.fingerprint ? { fingerprint: candidate.fingerprint } : {}),
    ...(candidate.allowAuthority ? { allowAuthority: true } : {}),
    ...(dependencies.userAgent ? { headers: { "User-Agent": dependencies.userAgent } } : {}),
  });
}

/**
 * The workbench's connection to a saved host. Every socket the transport
 * opens — the first and each reconnect — races the host's addresses again,
 * so a phone that left home switches to Tailscale on its own.
 */
export function connectHost(host: SavedHost, token: string, dependencies: ConnectDependencies, callbacks: ConnectCallbacks): { client: HostClient; connection: HostConnection } {
  let lastAddress: string | undefined;
  const candidates = () => socketCandidates(host.endpoints, host.fingerprint, dependencies.device);
  return createSocketHostClient(candidates()[0]?.url ?? "wss://unreachable.invalid/", token, {
    ...(dependencies.wakes ? { wakes: dependencies.wakes } : {}),
    createSocket: () => new RacingSocket(candidates(), (candidate) => openCandidate(dependencies, candidate), {
      onWinner: (candidate) => {
        if (candidate.url === lastAddress) return;
        lastAddress = candidate.url;
        callbacks.onAddress?.(candidate);
      },
      onFailure: (reason) => { if (reason === "certificate-mismatch") callbacks.onCertificateMismatch(); },
    }),
    onUnauthorized: callbacks.onUnauthorized,
  });
}
