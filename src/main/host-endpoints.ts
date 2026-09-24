import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname, type NetworkInterfaceInfo } from "node:os";
import type { UiHostEndpoint } from "../shared/connections.js";

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

export type AddressClass = "loopback" | "link-local" | "tailscale" | "lan";

/** 100.64.0.0/10 (the CGNAT range Tailscale hands out) or Tailscale's fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith("fd7a:115c:a1e0:")) return true;
  const match = /^100\.(\d+)\.\d+\.\d+$/u.exec(address);
  return match !== null && Number(match[1]) >= 64 && Number(match[1]) <= 127;
}

export function classifyAddress(address: string): AddressClass {
  const lower = address.toLowerCase().replace(/^::ffff:/u, "");
  if (lower === "::1" || /^127\./u.test(lower)) return "loopback";
  if (/^169\.254\./u.test(lower) || /^fe[89ab][0-9a-f]:/u.test(lower)) return "link-local";
  return isTailscaleAddress(lower) ? "tailscale" : "lan";
}

export interface EndpointListener {
  scheme: "http" | "https";
  host: string;
  port: number;
}

/** Names that stand for the machine rather than for one address. */
export interface EndpointNames {
  /** `<name>.local`. */
  localName?: string;
  /** `<machine>.<tailnet>.ts.net`, without the trailing dot. */
  magicDns?: string;
}

const ORDER: Record<string, number> = { lan: 0, mdns: 1, magicdns: 2, tailscale: 3, "lan-6": 4, "tailscale-6": 5, loopback: 6 };

function rank(endpoint: UiHostEndpoint): number {
  return ORDER[`${endpoint.kind ?? "lan"}${endpoint.ipv6 ? "-6" : ""}`] ?? 9;
}

/**
 * The URLs one listener is reachable at. A wildcard bind is reachable on every
 * interface: each usable address is an endpoint, and the machine's `.local`
 * and MagicDNS names are too when an address of their kind is among them.
 * `0.0.0.0` stands for IPv4 alone; `::` for both families.
 */
export function listenerEndpoints(
  listener: EndpointListener,
  interfaces: Interfaces,
  names: EndpointNames = {},
  options: { loopback?: boolean } = {},
): UiHostEndpoint[] {
  const url = (address: string) => `${listener.scheme}://${address.includes(":") ? `[${address}]` : address}:${listener.port}/`;
  const bare = listener.host.replace(/^\[|\]$/gu, "");
  const endpoints: UiHostEndpoint[] = [];
  const add = (address: string, family: "IPv4" | "IPv6", name?: string): void => {
    const kind = classifyAddress(address);
    if (kind === "link-local") return;
    if (kind === "loopback") {
      if (options.loopback !== false) endpoints.push({ url: url(family === "IPv6" ? "::1" : "127.0.0.1"), label: "This machine", reachability: "loopback", kind: "loopback" });
      return;
    }
    const ipv6 = family === "IPv6";
    const label = `${kind === "tailscale" ? "Tailscale" : "LAN"}${ipv6 ? " IPv6" : ""}${kind === "lan" && name ? ` (${name})` : ""}`;
    endpoints.push({ url: url(address), label, reachability: "network", kind, ...(name ? { interface: name } : {}), ...(ipv6 ? { ipv6: true } : {}) });
  };

  const wildcard = bare === "0.0.0.0" || bare === "::" || bare === "";
  if (bare === "localhost") add("127.0.0.1", "IPv4");
  // A name the operator bound is theirs to label.
  else if (!wildcard && isIP(bare) === 0) endpoints.push({ url: url(bare), label: bare, reachability: "network" });
  else if (!wildcard) add(bare, bare.includes(":") ? "IPv6" : "IPv4", interfaceOf(bare, interfaces));
  else {
    const families = bare === "0.0.0.0" ? ["IPv4"] : ["IPv4", "IPv6"];
    for (const [name, addresses] of Object.entries(interfaces)) {
      // Temporary IPv6 addresses rotate and expire; the first global and the first ULA stand for the rest.
      const ipv6Seen = new Set<string>();
      for (const entry of addresses ?? []) {
        if (entry.internal || !families.includes(entry.family)) continue;
        if (entry.family === "IPv6" && classifyAddress(entry.address) === "lan") {
          const scope = /^f[cd]/iu.test(entry.address) ? "ula" : "global";
          if (ipv6Seen.has(scope)) continue;
          ipv6Seen.add(scope);
        }
        add(entry.address, entry.family, name);
      }
    }
    if (options.loopback !== false) add("127.0.0.1", "IPv4");
  }

  if (wildcard && names.localName && endpoints.some((endpoint) => endpoint.kind === "lan")) {
    endpoints.push({ url: url(names.localName), label: ".local", reachability: "network", kind: "mdns" });
  }
  if (names.magicDns && endpoints.some((endpoint) => endpoint.kind === "tailscale")) {
    endpoints.push({ url: url(names.magicDns), label: "MagicDNS", reachability: "network", kind: "magicdns" });
  }
  return endpoints;
}

/** Several listeners' endpoints as one list: best first, loopback last, each URL once. */
export function mergeEndpoints(lists: readonly UiHostEndpoint[][]): UiHostEndpoint[] {
  const seen = new Set<string>();
  return lists.flat()
    .filter((endpoint) => !seen.has(endpoint.url) && seen.add(endpoint.url))
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => rank(a.endpoint) - rank(b.endpoint) || a.index - b.index)
    .map(({ endpoint }) => endpoint);
}

function interfaceOf(address: string, interfaces: Interfaces): string | undefined {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (addresses?.some((entry) => entry.address === address)) return name;
  }
  return undefined;
}

/**
 * The machine's multicast DNS name. macOS announces its LocalHostName, which
 * is often not the first label of `hostname()`; Avahi and Windows announce the
 * host name.
 */
export function localHostName(platform: NodeJS.Platform = process.platform, run: (command: string, args: string[]) => string = runQuietly): string | undefined {
  let name = platform === "darwin" ? run("scutil", ["--get", "LocalHostName"]).trim() : "";
  if (!name) name = hostname().replace(/\.local$/iu, "").split(".")[0] ?? "";
  return /^[A-Za-z0-9-]{1,63}$/u.test(name) ? `${name}.local` : undefined;
}

function runQuietly(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** MagicDNS answers reverse lookups for tailnet addresses at this resolver. */
const TAILSCALE_RESOLVER = "100.100.100.100";
const NAME_TTL_MS = 5 * 60_000;

/**
 * The machine's MagicDNS name, read with a reverse lookup of its own Tailscale
 * address at Tailscale's resolver: nothing runs, nothing is asked of the
 * Tailscale CLI, and without MagicDNS there is simply no answer.
 */
export class MagicDnsNames {
  private readonly cache = new Map<string, { name: string | undefined; until: number }>();

  constructor(
    private readonly reverse: (address: string) => Promise<string[]> = defaultReverse,
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(address: string): Promise<string | undefined> {
    const cached = this.cache.get(address);
    if (cached && cached.until > this.now()) return cached.name;
    const names = await this.reverse(address).catch(() => []);
    const name = names.map((entry) => entry.replace(/\.$/u, "").toLowerCase()).find((entry) => /^[a-z0-9.-]+$/u.test(entry) && entry.includes("."));
    this.cache.set(address, { name, until: this.now() + NAME_TTL_MS });
    return name;
  }

  /** The name of the first Tailscale address among `interfaces`. */
  async forInterfaces(interfaces: Interfaces): Promise<string | undefined> {
    const address = Object.values(interfaces).flat().find((entry) => entry && !entry.internal && isTailscaleAddress(entry.address))?.address;
    return address ? this.lookup(address) : undefined;
  }
}

function defaultReverse(address: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 1_000, tries: 1 });
  resolver.setServers([TAILSCALE_RESOLVER]);
  return resolver.reverse(address);
}
