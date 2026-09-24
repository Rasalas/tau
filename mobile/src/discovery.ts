import { canonicalFingerprint, type PairingEndpoint } from "../../src/shared/connections";
import { discoveredHosts, readTauServiceTxt, type DiscoveredHost, type ResolvedService } from "../../src/shared/discovery";
import type { SavedHost } from "./hosts";

export type { DiscoveredHost };

/** A Bonjour service as the native side resolved it: one address or name per report. */
export interface NativeService {
  /** The service instance name, what the host announces itself as. */
  name: string;
  /** An address or a name; IPv6 may come in brackets, an address with its interface zone. */
  host: string;
  port: number;
  txt: Record<string, string>;
}

const isLoopback = (address: string): boolean => address === "::1" || address.startsWith("127.");

/** The shared shape F06 reads records in (`src/shared/discovery.ts`). */
export function resolvedService(service: NativeService): ResolvedService {
  // Neither a trailing dot, brackets nor an interface zone ("%en0") belongs in an address.
  const host = service.host.replace(/\.$/u, "").replace(/%[^\]]*/u, "").replace(/^\[|\]$/gu, "");
  const isName = !host.includes(":") && /[a-z]/iu.test(host);
  return { name: service.name, port: service.port, txt: service.txt, addresses: isName ? [] : [host], ...(isName ? { hostName: host } : {}) };
}

/**
 * Tau hosts on this network, by F06's reading of the record (`v=1`, `id`,
 * `fp`). A record without a fingerprint is not Tau's: the app never talks to
 * a network host it cannot pin. The record is not authenticated; the digits
 * both screens show are. A simulator also reaches a host announced on the
 * development machine's loopback, which a phone never could.
 */
export function nearbyHosts(services: readonly NativeService[], virtual: boolean): DiscoveredHost[] {
  const resolved = services.map(resolvedService);
  const hosts = discoveredHosts(resolved);
  if (!virtual) return hosts.filter((host) => host.endpoints.length > 0);
  return hosts.map((host) => {
    if (host.endpoints.length > 0) return host;
    const loopback = resolved.find((service) => readTauServiceTxt(service.txt)?.hostId === host.hostId && service.addresses.some(isLoopback));
    return loopback ? Object.assign({}, host, { endpoints: [{ url: `https://127.0.0.1:${loopback.port}/`, kind: "loopback" as const }] }) : host;
  }).filter((host) => host.endpoints.length > 0);
}

/**
 * A saved host seen on the network with the pin it was paired with: the
 * addresses it announces now go first, so a changed DHCP lease does not strand
 * it. A record with another key (or, for an old pin, certificate) changes
 * nothing; that proves nothing.
 */
export function withDiscoveredEndpoints(host: SavedHost, found: DiscoveredHost): PairingEndpoint[] | undefined {
  const samePin = host.publicKey
    ? found.publicKey !== undefined && canonicalFingerprint(host.publicKey) === found.publicKey
    : host.fingerprint !== undefined && canonicalFingerprint(host.fingerprint) === found.fingerprint;
  if (!samePin) return undefined;
  const fresh = found.endpoints.filter((endpoint) => endpoint.kind !== "loopback");
  if (fresh.length === 0 || fresh.every((endpoint, index) => host.endpoints[index]?.url === endpoint.url)) return undefined;
  return [...fresh, ...host.endpoints.filter((endpoint) => !fresh.some((entry) => entry.url === endpoint.url))];
}
