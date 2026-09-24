/**
 * Who may reach a listening host, as Settings → Connections shows it (ADR 0023).
 * The host token belongs to the owner; every other client holds a token of its
 * own that it got by redeeming a single-use pairing link.
 */

/** What the host could read about a client from its user agent. */
export interface UiClientDevice {
  browser?: string;
  os?: string;
  kind: "desktop" | "phone" | "tablet" | "unknown";
}

/** A pairing link that has not been used and has not expired. The code itself is never listed. */
export interface UiPairingLink {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
}

/** A client that paired and holds a token of its own. */
export interface UiPairedClient {
  id: string;
  label: string;
  device: UiClientDevice;
  pairedAt: string;
  /** The last hello or request, as of the last time the host wrote it down. */
  lastSeenAt?: string;
  /** The address it last connected from; behind a proxy, the one the proxy forwarded. */
  lastAddress?: string;
  /** Open connections with this client's token right now. */
  connections: number;
  /** The connection asking is this client. */
  current: boolean;
}

/** A live connection that said hello with the host token. It cannot be revoked alone, only by rotating. */
export interface UiOwnerConnection {
  id: string;
  profile?: string;
  device: UiClientDevice;
  address?: string;
  since: string;
  current: boolean;
}

/**
 * How a device reaches an endpoint. A device that knows several picks the best
 * one it can reach itself, so the host lists every one it has.
 */
export type UiHostEndpointKind =
  /** 127.0.0.1: this machine only. */
  | "loopback"
  /** An address on the local network, IPv4 or IPv6. */
  | "lan"
  /** `<name>.local`, resolved over multicast DNS in the local network. */
  | "mdns"
  /** A Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
  | "tailscale"
  /** The Tailscale MagicDNS name, `<machine>.<tailnet>.ts.net`. */
  | "magicdns";

/** Where a client can reach this host, as a URL a browser opens. */
export interface UiHostEndpoint {
  url: string;
  label: string;
  /** Loopback is reachable only from this machine, so it is never offered as a QR code. */
  reachability: "loopback" | "network";
  kind?: UiHostEndpointKind;
  /** The interface it sits on, `en0` or `utun4`, when it is an address. */
  interface?: string;
  ipv6?: boolean;
}

/**
 * Network access, Settings → Connections: the listeners a host opens beside
 * its own loopback one. Off by default; the two switches combine.
 */
export interface UiNetworkSettings {
  /** Every interface on `port`, TLS only. */
  lan: boolean;
  /** The Tailscale addresses on `port`, TLS only, and the loopback proxy listener on `proxyPort`. */
  tailscale: boolean;
  port: number;
  /** Where a reverse proxy on this machine (`tailscale serve`) sends its traffic. Plain HTTP, loopback only. */
  proxyPort: number;
  /** A certificate of the user's own instead of the self-signed one; re-read when it changes. */
  certificate?: { certPath: string; keyPath: string };
}

export interface UiNetworkListener {
  host: string;
  port: number;
  /** `network` speaks TLS; `proxy` is plain HTTP on loopback and treats every peer as remote. */
  kind: "network" | "proxy";
}

export interface UiNetworkCertificate {
  source: "self-signed" | "supplied";
  fingerprint: string;
  validTo: string;
  certPath: string;
  warnings: string[];
}

export interface UiNetworkAccess {
  settings: UiNetworkSettings;
  /** What listens right now. */
  listeners: UiNetworkListener[];
  /** Why something that was asked for does not listen: a port in use, no Tailscale address, a certificate that does not load. */
  problems: string[];
  /** This machine has a Tailscale address right now. */
  tailscaleUp: boolean;
  /** The certificate the network listeners serve, once one is needed. */
  certificate?: UiNetworkCertificate;
}

/** A change to network access; `certificate: null` goes back to the self-signed one. */
export type UiNetworkSettingsInput = Partial<Omit<UiNetworkSettings, "certificate">> & {
  certificate?: UiNetworkSettings["certificate"] | null;
};

export const DEFAULT_NETWORK_SETTINGS: UiNetworkSettings = { lan: false, tailscale: false, port: 7788, proxyPort: 7789 };

export interface UiConnections {
  scheme: "ws" | "wss";
  endpoints: UiHostEndpoint[];
  /** The browser client is built and served; without it a pairing link has nothing to open. */
  webClient: boolean;
  /** SHA-256 of the TLS certificate, for comparing with the browser's warning. */
  fingerprint?: string;
  tokenPath: string;
  /** Absent on a host that cannot open listeners of its own. */
  network?: UiNetworkAccess;
  links: UiPairingLink[];
  clients: UiPairedClient[];
  owners: UiOwnerConnection[];
}

export interface UiCreatedPairingLink {
  link: UiPairingLink;
  /** The single-use secret. Shown once, to the owner who made it. */
  code: string;
  /** One pairing URL per endpoint, the code in the fragment. */
  urls: UiHostEndpoint[];
}

/** How long a new pairing link may be redeemed; the host clamps anything else. */
export const PAIRING_LINK_LIFETIMES_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

/** `url#pair=code`: the fragment never reaches a server log, and the page drops it before rendering. */
export function pairingUrl(endpointUrl: string, code: string): string {
  return `${endpointUrl.replace(/#.*$/u, "")}#pair=${encodeURIComponent(code)}`;
}

/** Why a socket was closed with 4401; the client words its notice after it. */
export const ACCESS_CLOSE_REASON = {
  unauthorized: "unauthorized",
  revoked: "revoked",
  rotated: "token-rotated",
} as const;
