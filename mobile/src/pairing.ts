import type { PairingEndpoint } from "../../src/shared/connections";
import { pairWithHost, type PairingResult, type PairingSocket } from "../../src/workbench/host-pairing";
import { RacingSocket, listAddresses, socketCandidates, type AttemptSocket, type DeviceNetwork, type RaceFailure, type RaceOptions, type SocketCandidate } from "./endpoints";
import type { SavedHost } from "./hosts";
import { connectCandidate, type MobileConnect } from "./relay-connect";

/** A host to pair with, from a QR code, a pasted link or a Bonjour record. */
export interface PairTarget {
  hostId: string;
  name: string;
  /** The host's key, from a link or a Bonjour record; pinned in place of `fingerprint`. */
  publicKey?: string;
  /** One certificate, from a host that names no key (before key pins). */
  fingerprint?: string;
  endpoints: PairingEndpoint[];
  /** From a link; without one the owner is asked all the same. */
  code?: string;
  connect?: MobileConnect;
}

export type PairOutcome =
  | { state: "approved"; host: SavedHost; token: string }
  | Exclude<PairingResult, { state: "approved" }>;

export interface PairingDevice extends DeviceNetwork {
  /** How the phone names itself to the host's owner. */
  name: string;
}

export interface PairDependencies {
  device: PairingDevice;
  openSocket(candidate: SocketCandidate): AttemptSocket & PairingSocket;
  now?(): Date;
  race?: RaceOptions;
}

export type PairingFailure = { reason: "no-address" } | RaceFailure;

export type EndpointChoice =
  | { candidate: SocketCandidate; fingerprint?: string; publicKey?: string }
  | { failure: PairingFailure };

/** Races the candidates once and closes the winner: which address this phone reaches the host on right now. */
export function chooseEndpoint(candidates: readonly SocketCandidate[], open: (candidate: SocketCandidate) => AttemptSocket, race?: RaceOptions, signal?: AbortSignal): Promise<EndpointChoice> {
  if (signal?.aborted || candidates.length === 0) return Promise.resolve({ failure: { reason: "no-address" } });
  return new Promise((resolve) => {
    const socket = new RacingSocket(candidates, open, race);
    const cancelled = () => { socket.onclose = null; socket.close(); resolve({ failure: { reason: "unreachable" } }); };
    signal?.addEventListener("abort", cancelled, { once: true });
    const settle = (choice: EndpointChoice) => { signal?.removeEventListener("abort", cancelled); resolve(choice); };
    socket.onopen = () => {
      const candidate = socket.winner!;
      settle({ candidate, ...(socket.fingerprint ? { fingerprint: socket.fingerprint } : {}), ...(socket.publicKey ? { publicKey: socket.publicKey } : {}) });
      socket.onclose = null;
      socket.close();
    };
    socket.onclose = () => settle({ failure: socket.failure ?? { reason: "unreachable" } });
  });
}

/**
 * What the pairing digits are bound to, as the host computes them for the
 * listener the socket came through (ADR 0024): the pinned key; the old
 * pinned certificate, for a host before key pins; the key a TLS address
 * showed when nothing was pinned; nothing through a proxy that ends TLS
 * itself (Tailscale Serve) or on a plaintext loopback socket.
 */
export function pairingBinding(candidate: SocketCandidate, seen: { fingerprint?: string; publicKey?: string }): { publicKey: string } | { fingerprint: string } {
  if (candidate.publicKey) return { publicKey: seen.publicKey === candidate.publicKey ? candidate.publicKey : "" };
  if (candidate.fingerprint) return { fingerprint: seen.fingerprint === candidate.fingerprint ? candidate.fingerprint : "" };
  if (candidate.trust !== "authority" || candidate.proxied) return { publicKey: "" };
  return { publicKey: seen.publicKey ?? "" };
}

/** What the pairing screen says when no address let the phone in. */
export function pairingFailureMessage(failure: PairingFailure): string {
  switch (failure.reason) {
    case "no-address":
      return "None of this host's addresses can be reached from a phone. Turn on Local network or Tailscale in the host's Settings → Connections, then scan a new code.";
    case "unreachable":
      return "The host did not answer on any of its addresses. Is this phone on the same network, or on Tailscale?";
    case "certificate-mismatch":
      return `${listAddresses(failure.addresses)} answered with another certificate than the one in the code. This phone did not send it anything.`;
    case "untrusted-certificate":
      return `${listAddresses(failure.addresses)} showed a certificate this phone does not trust, so the phone sent it nothing. Something on this network may be in between; try another network.`;
  }
}

/**
 * Pairs with a host over the best address this phone reaches it on: the
 * owner compares the digits and allows it, and the phone keeps the host with
 * its token. The socket pins the host's certificate on every TLS address.
 */
export async function pairDevice(target: PairTarget, dependencies: PairDependencies, callbacks: {
  onWaiting?(waiting: { verification: string; expiresAt: string }): void;
  onAddress?(candidate: SocketCandidate): void;
  signal?: AbortSignal;
} = {}): Promise<PairOutcome> {
  const relay = target.connect ? connectCandidate(target.connect, targetPins(target)) : undefined;
  const candidates = [...socketCandidates(target.endpoints, targetPins(target), dependencies.device), ...(relay ? [relay] : [])];
  const choice = await chooseEndpoint(candidates, dependencies.openSocket, dependencies.race, callbacks.signal);
  if (callbacks.signal?.aborted) return { state: "failed", message: "Pairing was cancelled." };
  if ("failure" in choice) return { state: "failed", message: pairingFailureMessage(choice.failure) };
  callbacks.onAddress?.(choice.candidate);
  const result = await pairWithHost({
    url: choice.candidate.url,
    ...(target.code ? { code: target.code } : {}),
    name: dependencies.device.name,
    ...pairingBinding(choice.candidate, choice),
    ...(callbacks.onWaiting ? { onWaiting: callbacks.onWaiting } : {}),
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    createSocket: () => dependencies.openSocket(choice.candidate),
  });
  if (result.state !== "approved") return result;
  const at = (dependencies.now?.() ?? new Date()).toISOString();
  const endpoint = target.endpoints.find((entry) => sameAddress(entry.url, choice.candidate.url));
  return {
    state: "approved",
    token: result.token,
    host: {
      id: target.hostId,
      name: target.name,
      ...targetPins(target),
      endpoints: target.endpoints,
      ...(target.connect ? { connect: true } : {}),
      access: result.access,
      addedAt: at,
      lastUsedAt: at,
      ...(endpoint ? { lastEndpoint: endpoint } : {}),
    },
  };
}

/** The key when the host named one; its certificate only when it did not. */
export function targetPins(target: Pick<PairTarget, "publicKey" | "fingerprint">): { publicKey: string } | { fingerprint: string } | Record<string, never> {
  if (target.publicKey) return { publicKey: target.publicKey };
  return target.fingerprint ? { fingerprint: target.fingerprint } : {};
}

/** `https://h:1/` and `wss://h:1/` name the same listener; the Android emulator's alias aside. */
export function sameAddress(endpointUrl: string, socketUrl: string): boolean {
  try {
    const a = new URL(endpointUrl);
    const b = new URL(socketUrl);
    return a.port === b.port && (a.hostname === b.hostname || b.hostname === "10.0.2.2");
  } catch {
    return false;
  }
}
