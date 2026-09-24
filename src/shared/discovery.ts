/**
 * Finding a host on the local network with Bonjour/mDNS (DNS-SD). A host with
 * Local network on announces `_tau._tcp` on its network listener's port; the
 * TXT record carries its id and certificate fingerprint and nothing secret.
 * Pairing still needs the owner's approval with matching digits (ADR 0024).
 * The desktop, the native app and tests share this contract.
 */
import { canonicalFingerprint, type PairingEndpoint } from "./connections.js";

export const TAU_SERVICE_TYPE = "_tau._tcp";
/** Real runs in tests and isolated instances announce this type, never the real one. */
export const TAU_TEST_SERVICE_TYPE = "_tau-test._tcp";
/** The TXT record's own version; a reader ignores a record of another one. */
export const TAU_TXT_VERSION = "1";

/** `_name._tcp`: what a service type must look like before it reaches a command line. */
export function isServiceType(value: string): boolean {
  return /^_[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?\._tcp$/u.test(value);
}

/** `v=1`, `id=<host id>`, `fp=<64 hex>`: the fingerprint without colons, as in a pairing link. */
export function tauServiceTxt(record: { hostId: string; fingerprint: string }): Record<string, string> {
  const fingerprint = canonicalFingerprint(record.fingerprint);
  if (!fingerprint) throw new Error("A Bonjour record needs the SHA-256 fingerprint of the certificate.");
  return { v: TAU_TXT_VERSION, id: record.hostId, fp: fingerprint.replace(/:/gu, "") };
}

/** The host id and fingerprint of a TXT record, or undefined for anything but a version-1 Tau record. */
export function readTauServiceTxt(txt: Readonly<Record<string, string>>): { hostId: string; fingerprint: string } | undefined {
  if (txt.v !== TAU_TXT_VERSION) return undefined;
  const hostId = txt.id ?? "";
  const fingerprint = canonicalFingerprint(txt.fp ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(hostId) || !fingerprint) return undefined;
  return { hostId, fingerprint };
}

/** A Tau host some machine on this network announces. */
export interface DiscoveredHost {
  /** The Bonjour instance name; the network may have suffixed it after a clash. */
  name: string;
  hostId: string;
  /** `AB:CD:…`; a device pins it before it asks to pair. */
  fingerprint: string;
  port: number;
  /** The target the record names, `<name>.local`. */
  hostName?: string;
  addresses: string[];
  /** Every URL to try, addresses before the `.local` name. */
  endpoints: PairingEndpoint[];
  /** This machine's own host. */
  self?: boolean;
}

/** `connections-discover`: what answered while the host looked. */
export interface UiDiscoveredHosts {
  hosts: DiscoveredHost[];
  serviceType: string;
  /** Why nothing could be looked for: no Avahi, the responder refused. */
  problem?: string;
}

/** One resolved record as a browser reports it, before it is read as Tau's. */
export interface ResolvedService {
  name: string;
  hostName?: string;
  port: number;
  txt: Record<string, string>;
  addresses: string[];
}

/**
 * An address another device can dial: not loopback, unspecified or link-local.
 * Resolving the `.local` name of this very machine answers 127.0.0.1 and ::1 too.
 */
export function isReachableAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.includes(":")) return lower !== "::1" && lower !== "::" && !/^fe[89ab]/u.test(lower);
  return !/^(?:127\.|0\.|169\.254\.)/u.test(lower);
}

function urlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * The URLs a resolved record offers, best first: IPv4, then IPv6 (a URL cannot
 * carry a link-local zone), then the `.local` name.
 */
export function discoveredEndpoints(service: Pick<ResolvedService, "hostName" | "port" | "addresses">): PairingEndpoint[] {
  const reachable = service.addresses.filter(isReachableAddress);
  const v4 = reachable.filter((address) => !address.includes(":"));
  const v6 = reachable.filter((address) => address.includes(":"));
  const endpoints: PairingEndpoint[] = [...new Set([...v4, ...v6])].map((address) => ({ url: `https://${urlHost(address)}:${service.port}/`, kind: "lan" }));
  const name = service.hostName?.replace(/\.$/u, "");
  if (name) endpoints.push({ url: `https://${name.toLowerCase()}:${service.port}/`, kind: "mdns" });
  return endpoints;
}

/**
 * Tau's hosts among resolved records: one per host id, its addresses merged,
 * since a host is seen once per interface and address family.
 */
export function discoveredHosts(services: readonly ResolvedService[], ownHostId?: string): DiscoveredHost[] {
  const hosts = new Map<string, DiscoveredHost & { key: string }>();
  for (const service of services) {
    const record = readTauServiceTxt(service.txt);
    if (!record || !Number.isInteger(service.port) || service.port <= 0 || service.port > 65535) continue;
    // A host that changed its certificate is a different one to pin.
    const key = `${record.hostId}\0${record.fingerprint}\0${service.port}`;
    const known = hosts.get(key);
    const addresses = [...new Set([...(known?.addresses ?? []), ...service.addresses.filter(isReachableAddress)])];
    const hostName = known?.hostName ?? service.hostName?.replace(/\.$/u, "");
    hosts.set(key, {
      key,
      name: known?.name ?? service.name,
      ...record,
      port: service.port,
      ...(hostName ? { hostName } : {}),
      addresses,
      endpoints: discoveredEndpoints({ ...(hostName ? { hostName } : {}), port: service.port, addresses }),
      ...(ownHostId && record.hostId === ownHostId ? { self: true } : {}),
    });
  }
  return [...hosts.values()]
    .map(({ key: _key, ...host }) => host)
    .sort((a, b) => Number(a.self ?? false) - Number(b.self ?? false) || a.name.localeCompare(b.name));
}
