import { createSocketHostClient } from "../../src/workbench/host-connection-socket";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostConnection } from "../../src/workbench/host-connection";
import type { HostWakeSource } from "../../src/workbench/host-link";
import { RacingSocket, socketCandidates, type DeviceNetwork, type SocketCandidate } from "./endpoints";
import type { SavedHost, WonAddress } from "./hosts";
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
  /** The host answered a hello with this token, on the address that won; after every reconnect too. */
  onHello?(won: WonAddress): void;
}

/** A pinned native socket for one candidate address. */
export function openCandidate(dependencies: Pick<ConnectDependencies, "bridge" | "userAgent">, candidate: SocketCandidate): NativeSocket {
  return new NativeSocket(dependencies.bridge, candidate.url, {
    ...(candidate.publicKey ? { publicKey: candidate.publicKey } : {}),
    ...(candidate.fingerprint ? { fingerprint: candidate.fingerprint } : {}),
    ...(candidate.allowAuthority ? { allowAuthority: true } : {}),
    ...(dependencies.userAgent ? { headers: { "User-Agent": dependencies.userAgent } } : {}),
  });
}

/**
 * The workbench's connection to a saved host. Every socket the transport
 * opens — the first and each reconnect — races the host's addresses again,
 * so a phone that left home switches to Tailscale on its own. `host` is read
 * at every race, so a migrated pin or a refreshed address list applies to the
 * next socket.
 */
export function connectHost(host: () => SavedHost, token: string, dependencies: ConnectDependencies, callbacks: ConnectCallbacks): { client: HostClient; connection: HostConnection } {
  let lastAddress: string | undefined;
  let won: WonAddress | undefined;
  const candidates = () => {
    const current = host();
    return socketCandidates(current.endpoints, { ...(current.publicKey ? { publicKey: current.publicKey } : {}), ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}) }, dependencies.device);
  };
  const { client, connection } = createSocketHostClient(candidates()[0]?.url ?? "wss://unreachable.invalid/", token, {
    ...(dependencies.wakes ? { wakes: dependencies.wakes } : {}),
    createSocket: () => new RacingSocket(candidates(), (candidate) => openCandidate(dependencies, candidate), {
      onWinner: (candidate, seen) => {
        won = { candidate, seen };
        if (candidate.url === lastAddress) return;
        lastAddress = candidate.url;
        callbacks.onAddress?.(candidate);
      },
      onFailure: (reason) => { if (reason === "certificate-mismatch") callbacks.onCertificateMismatch(); },
      onMessage: (data) => {
        if (!callbacks.onHello || !won || typeof data !== "string" || !data.includes("\"hello-reply\"")) return;
        const address = won;
        let frame: { type?: unknown } | undefined;
        try { frame = JSON.parse(data) as { type?: unknown }; } catch { return; }
        // After the transport has taken the reply in, so what the callback asks is sent on a live connection.
        if (frame?.type === "hello-reply") setTimeout(() => callbacks.onHello?.(address), 0);
      },
    }),
    onUnauthorized: callbacks.onUnauthorized,
  });
  return { client, connection };
}
