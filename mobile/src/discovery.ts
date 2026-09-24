import { canonicalFingerprint, type PairingEndpoint } from "../../src/shared/connections";
import type { SavedHost } from "./hosts";

/** A Bonjour service the native side found and resolved. */
export interface DiscoveredService {
  /** The service instance name, what the host advertises itself as. */
  name: string;
  /** An address or a name, as resolved; IPv6 in brackets. */
  host: string;
  port: number;
  txt: Record<string, string>;
}

/** A Tau host on this network, from its Bonjour record. */
export interface DiscoveredHost {
  hostId: string;
  name: string;
  fingerprint: string;
  endpoint: PairingEndpoint;
}

const first = (txt: Record<string, string>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = txt[key]?.trim();
    if (value) return value;
  }
  return undefined;
};

/**
 * What a record says, when it says enough: the host id and the fingerprint of
 * the certificate its LAN listener serves (F06). A record without a
 * fingerprint is skipped — the app never talks to a network host it cannot pin.
 * The record is not authenticated; the digits both screens show are.
 */
export function discoveredHost(service: DiscoveredService): DiscoveredHost | undefined {
  const hostId = first(service.txt, ["host", "id", "hostId"]);
  const fingerprint = canonicalFingerprint(first(service.txt, ["fp", "fingerprint", "sha256"]) ?? "");
  if (!hostId || !fingerprint || !service.host || !(service.port > 0 && service.port < 65_536)) return undefined;
  const address = service.host.replace(/\.$/u, "");
  const bracketed = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return {
    hostId,
    fingerprint,
    name: first(service.txt, ["name"]) ?? service.name,
    endpoint: { url: `https://${bracketed}:${service.port}/`, kind: address.endsWith(".local") ? "mdns" : "lan" },
  };
}

/** One entry per host id; a host advertised on two interfaces is still one. */
export function discoveredHosts(services: readonly DiscoveredService[]): DiscoveredHost[] {
  const hosts = new Map<string, DiscoveredHost>();
  for (const service of services) {
    const host = discoveredHost(service);
    if (host && !hosts.has(host.hostId)) hosts.set(host.hostId, host);
  }
  return [...hosts.values()];
}

/**
 * A saved host seen on the network with the pin it was paired with: its
 * address goes first, so a changed DHCP lease does not strand it. A record
 * with another fingerprint changes nothing; that is not proof of anything.
 */
export function withDiscoveredEndpoint(host: SavedHost, found: DiscoveredHost): PairingEndpoint[] | undefined {
  if (!host.fingerprint || canonicalFingerprint(host.fingerprint) !== found.fingerprint) return undefined;
  if (host.endpoints[0]?.url === found.endpoint.url) return undefined;
  return [found.endpoint, ...host.endpoints.filter((endpoint) => endpoint.url !== found.endpoint.url)];
}
