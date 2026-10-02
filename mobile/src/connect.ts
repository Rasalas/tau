import { decodeHostServerFrame, type HostHelloReply } from "../../src/shared/host-transport";
import { createSocketHostClient } from "../../src/workbench/host-connection-socket";
import type { HostClient } from "../../src/workbench/host-client";
import type { HostConnection } from "../../src/workbench/host-connection";
import type { HostWakeSource } from "../../src/workbench/host-link";
import { RacingSocket, listAddresses, socketCandidates, type CertificateRefusal, type DeviceNetwork, type SocketCandidate } from "./endpoints";
import type { SavedHost, WonAddress } from "./hosts";
import { connectCandidate, type MobileConnect } from "./relay-connect";
import { NativeSocket, type SocketBridge } from "./native-socket";

export interface ConnectDependencies {
  bridge: SocketBridge;
  connect?: MobileConnect;
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
  /**
   * No address let the phone in, and at least one showed a wrong key or a
   * certificate the phone does not trust. The rest may just be out of reach;
   * reconnecting would meet the same certificate.
   */
  onCertificateRefused(refusal: CertificateRefusal): void;
  /** The host answered a hello with this token, on the address that won; after every reconnect too. */
  onHello?(won: WonAddress, reply: HostHelloReply): void;
}

/** What the host list says after a workbench left because of a certificate. */
export function certificateRefusalNotice(hostName: string, refusal: CertificateRefusal): string {
  const addresses = listAddresses(refusal.addresses);
  return refusal.reason === "certificate-mismatch"
    ? `${addresses} answered for ${hostName} with another key than the one this phone pinned, so the phone sent it nothing. A renewed certificate keeps the key; if the host's key was replaced on purpose, remove it here and scan a new pairing code.`
    : `${addresses} showed a certificate this phone does not trust, so the phone did not connect to ${hostName}. Something on this network may be in between; try another network.`;
}

/** A pinned native socket for one candidate address. */
export function openCandidate(dependencies: Pick<ConnectDependencies, "bridge" | "userAgent">, candidate: SocketCandidate): NativeSocket {
  return new NativeSocket(dependencies.bridge, candidate.url, {
    ...(candidate.publicKey ? { publicKey: candidate.publicKey } : {}),
    ...(candidate.fingerprint ? { fingerprint: candidate.fingerprint } : {}),
    ...(candidate.allowAuthority ? { allowAuthority: true } : {}),
    ...(candidate.connect ? { connect: candidate.connect } : {}),
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
    const pins = { ...(current.publicKey ? { publicKey: current.publicKey } : {}), ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}) };
    const relay = dependencies.connect ? connectCandidate(dependencies.connect, pins) : undefined;
    return [...socketCandidates(current.endpoints, pins, dependencies.device), ...(relay ? [relay] : [])];
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
      onFailure: (failure) => { if (failure.reason !== "unreachable") callbacks.onCertificateRefused(failure); },
      onMessage: (data) => {
        if (!callbacks.onHello || !won || typeof data !== "string" || !data.includes("\"hello-reply\"")) return;
        const address = won;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { return; }
        const frame = decodeHostServerFrame(parsed);
        // After the transport has taken the reply in.
        if (frame?.type === "hello-reply") setTimeout(() => callbacks.onHello?.(address, frame.reply), 0);
      },
    }),
    onUnauthorized: callbacks.onUnauthorized,
  });
  return { client, connection };
}
