import { parsePairingPayload, type PairingPayload } from "../../src/shared/connections";
import { decodeConnectOffer } from "../../src/shared/managed-connections";
import type { HostPins, SocketCandidate } from "./endpoints";

/** Saved separately from host metadata and its paired-client token in the secure store. */
export interface MobileConnect {
  relay: string;
  id: string;
  token: string;
  /** Original inner host TLS address, including its path and query, without pairing fragment. */
  url: string;
}

export interface MobilePairingPayload extends PairingPayload { connect?: MobileConnect }

export function parseMobilePairingPayload(text: string): MobilePairingPayload | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("tau-connect:")) return parsePairingPayload(trimmed);
  const offer = decodeConnectOffer(trimmed);
  if (!offer) return undefined;
  const payload = parsePairingPayload(offer.link);
  if (!payload || (!payload.publicKey && !payload.fingerprint)) return undefined;
  try {
    const inner = new URL(offer.link);
    const relay = new URL(offer.relay);
    if (inner.protocol !== "https:" || inner.username || inner.password || relay.search || relay.hash) return undefined;
    inner.protocol = "wss:"; inner.hash = "";
    return { ...payload, connect: { relay: relay.origin, id: offer.id, token: offer.token, url: inner.href } };
  } catch { return undefined; }
}

/** Relay routing never lets a CA replace the host's pin, even for an old certificate pin. */
export function connectCandidate(connect: MobileConnect, pins: HostPins): SocketCandidate | undefined {
  if (!pins.publicKey && !pins.fingerprint) return undefined;
  return {
    url: connect.url,
    trust: "pin",
    ...(pins.publicKey ? { publicKey: pins.publicKey } : { fingerprint: pins.fingerprint! }),
    allowAuthority: false,
    rank: 20,
    connect: { url: relayClientUrl(connect), token: connect.token },
  };
}

export function relayClientUrl(connect: Pick<MobileConnect, "relay" | "id">): string {
  const url = new URL(`/v1/client/${connect.id}`, connect.relay);
  url.protocol = "wss:";
  return url.href;
}
