/**
 * Who may reach a listening host, as Settings → Connections shows it (ADR 0023,
 * ADR 0024). The host token belongs to the owner; every other client holds a
 * token of its own, which it got by asking to pair and being allowed on the host.
 */

/** What a paired device may do: everything a user can, or look without changing anything. */
export type DeviceAccess = "full" | "read-only";

/** How many days without use end a device's token; `null` keeps it until it is revoked. */
export type IdleTimeoutDays = 30 | 90 | 365 | null;
export const IDLE_TIMEOUT_CHOICES: readonly IdleTimeoutDays[] = [30, 90, 365, null];
export const DEFAULT_IDLE_TIMEOUT_DAYS: IdleTimeoutDays = 90;
/** Settings warns this long before a token runs out unused. */
export const IDLE_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;

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
  /** What the device gets unless the owner picks otherwise when allowing it. */
  access: DeviceAccess;
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
  /** Who the proxy in front of an open connection named (Tailscale Serve's user login). Shown, never trusted. */
  proxyUser?: string;
  /** Open connections with this client's token right now. */
  connections: number;
  /** The connection asking is this client. */
  current: boolean;
  access: DeviceAccess;
  idleTimeoutDays: IdleTimeoutDays;
  /** When the token stops working unless the device connects before; absent when it never does. */
  expiresAt?: string;
  /**
   * The last thing it changed on the host, never its input: `action` is the
   * method or `<extension>/<command>`, `label` how it reads ("sent a prompt"),
   * `thread` the current title of the thread it acted on. A call the client
   * made on its own after that (a title after a prompt) does not replace it.
   */
  lastAction?: { action: string; label?: string; thread?: string; at: string };
  /** Paired under the same approval as this device, as its machine's agents (ADR 0027); revoked on its own. */
  companionOf?: string;
}

/**
 * A device waiting to be let in. Both sides show `verification`; the owner
 * allows it only when the device in their hand shows the same digits.
 */
export interface UiPairingRequest {
  id: string;
  /** What the device calls itself, if it said; nothing is decided on it. */
  name?: string;
  device: UiClientDevice;
  address?: string;
  /** It came with a pairing link, and this is the link's label; absent for a request without one. */
  link?: { label?: string };
  verification: string;
  /** From the link, or Full; the owner may change it when allowing. */
  access: DeviceAccess;
  /** A second device the same approval lets in: the asking machine's agents, with the name it will be listed under (ADR 0027). */
  companion?: { name: string };
  createdAt: string;
  expiresAt: string;
}

/** A live connection that said hello with the host token. It cannot be revoked alone, only by rotating. */
export interface UiOwnerConnection {
  id: string;
  profile?: string;
  device: UiClientDevice;
  address?: string;
  /** Who the proxy in front of it named; see `UiPairedClient.proxyUser`. */
  proxyUser?: string;
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
  /**
   * A proxy in front of the host answers here with a certificate browsers
   * trust (Tailscale Serve's), not the host's own: a client does not pin the
   * host's fingerprint for it.
   */
  trustedCertificate?: boolean;
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
  /**
   * While Local network listens, announce it with Bonjour so devices here find
   * it. Settings written before this existed read as off: announcing asks
   * macOS for local network access, and that question belongs to a click.
   */
  announce: boolean;
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
  /** SHA-256 of its public key: what a device pins. A renewal of the self-signed one keeps it. */
  publicKey?: string;
  validTo: string;
  certPath: string;
  warnings: string[];
}

/** The Bonjour announcement of the local network listener. */
export interface UiNetworkAnnouncement {
  /** `unavailable`: the system has no responder Tau can use (no Avahi); `failed`: it stopped, retried every minute. */
  state: "starting" | "announced" | "failed" | "unavailable";
  /** What devices see; the network may have renamed it after a clash. */
  name: string;
  serviceType: string;
  detail?: string;
}

export interface UiNetworkAccess {
  settings: UiNetworkSettings;
  /** Absent while nothing is to be announced. */
  announcement?: UiNetworkAnnouncement;
  /** What listens right now. */
  listeners: UiNetworkListener[];
  /** Why something that was asked for does not listen: a port in use, no Tailscale address, a certificate that does not load. */
  problems: string[];
  /** This machine has a Tailscale address right now. */
  tailscaleUp: boolean;
  /** A package keeps the proxy listener open for a proxy it set up, whatever the switches say. */
  proxyHeld?: boolean;
  /** The certificate the network listeners serve, once one is needed. */
  certificate?: UiNetworkCertificate;
}

/** A change to network access; `certificate: null` goes back to the self-signed one. */
export type UiNetworkSettingsInput = Partial<Omit<UiNetworkSettings, "certificate">> & {
  certificate?: UiNetworkSettings["certificate"] | null;
};

export const DEFAULT_NETWORK_SETTINGS: UiNetworkSettings = { lan: false, tailscale: false, port: 7788, proxyPort: 7789, announce: true };

export interface UiConnections {
  /** This host's stable id, the same in a pairing link and its Bonjour record. */
  hostId?: string;
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
  requests: UiPairingRequest[];
  clients: UiPairedClient[];
  owners: UiOwnerConnection[];
}

export interface UiCreatedPairingLink {
  link: UiPairingLink;
  /** The single-use secret. Shown once, to the owner who made it. */
  code: string;
  /** One pairing URL per endpoint; each carries the code, the fingerprint and every other endpoint in its fragment. */
  urls: UiHostEndpoint[];
}

/** Something about the installed service the user should fix, with the command that does it. */
export interface UiHostServiceProblem {
  code: string;
  message: string;
  command?: string;
}

/**
 * The host as a system service of the machine it runs on: a LaunchAgent, a
 * systemd user unit or a Task Scheduler task that starts it at login and keeps
 * it running without a window.
 */
export interface UiHostService {
  supported: boolean;
  /** Why this machine cannot run it, when it cannot. */
  reason?: string;
  manager?: "launchd" | "systemd" | "task-scheduler";
  /** What the service manager calls it. */
  label?: string;
  installed: boolean;
  /** A host the service started answers on this machine. */
  running: boolean;
  /** The host answering this call is that one. */
  serving: boolean;
  /** The unit names another copy of Tau or other settings than this host would write; installing again repairs it. */
  stale: boolean;
  /** The version the running service host reported. */
  version?: string;
  unitPath?: string;
  logPath: string;
  problems: UiHostServiceProblem[];
  /** The invisible display beside the service; absent from a host before it. */
  display?: UiHostDisplay;
}

/**
 * An invisible display beside a Linux service host (`tau service install
 * --display`): Xvfb for agents' GUI runs, and a Tau window on it that gives
 * the host its window halves (preview, captures).
 */
export interface UiHostDisplay {
  supported: boolean;
  /** Why this machine cannot have one. */
  reason?: string;
  installed: boolean;
  /** `:99`. */
  display?: string;
  xvfbRunning: boolean;
  /** The host starts the window when a call needs one and stops it after `idleMinutes` without one. */
  windowRunning: boolean;
  idleMinutes: number;
}

/** What the owner may change about a paired device. */
export interface UiClientUpdate {
  label?: string;
  access?: DeviceAccess;
  idleTimeoutDays?: IdleTimeoutDays;
}

/** How long a new pairing link may be redeemed; the host clamps anything else. */
export const PAIRING_LINK_LIFETIMES_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

/** One address in a pairing link, with its kind so a device can choose (a phone on cellular skips `lan`). */
export interface PairingEndpoint {
  url: string;
  kind?: UiHostEndpointKind;
  /**
   * A proxy answers here with a certificate a CA vouches for (Tailscale
   * Serve): a device checks chain and name and pins nothing. Only a DNS name
   * outside `.local` can carry it; anywhere else the host's key is pinned.
   */
  trustedCertificate?: boolean;
}

/** What a pairing link or QR code tells a device, besides where the link itself points. */
export interface PairingPayload {
  code: string;
  /** SHA-256 of the host's own certificate, `AB:CD:…`; what apps before key pins pin. */
  fingerprint?: string;
  /** SHA-256 of the host's public key (SPKI), `AB:CD:…`; pinned on every endpoint not marked `trustedCertificate`. */
  publicKey?: string;
  hostId?: string;
  hostName?: string;
  /** Every address the host listens on, best first; the link's own origin leads. */
  endpoints: PairingEndpoint[];
}

const ENDPOINT_KINDS: ReadonlySet<string> = new Set<UiHostEndpointKind>(["loopback", "lan", "mdns", "tailscale", "magicdns"]);
const isEndpointKind = (value: string | null | undefined): value is UiHostEndpointKind => typeof value === "string" && ENDPOINT_KINDS.has(value);

/** Addresses from the wire: `http(s)` URLs with a known kind or none, at most `max`. */
export function decodePairingEndpoints(value: unknown, max = 16): PairingEndpoint[] {
  if (!Array.isArray(value)) return [];
  const endpoints: PairingEndpoint[] = [];
  for (const item of value) {
    const url = (item as { url?: unknown } | null)?.url;
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (typeof url !== "string" || url.length > 2_048 || !/^https?:\/\/[^\s]+$/u.test(url) || endpoints.some((entry) => entry.url === url)) continue;
    const trusted = (item as { trustedCertificate?: unknown }).trustedCertificate === true && authorityName(url);
    endpoints.push({ url, ...(typeof kind === "string" && isEndpointKind(kind) ? { kind } : {}), ...(trusted ? { trustedCertificate: true } : {}) });
    if (endpoints.length === max) break;
  }
  return endpoints;
}

/**
 * `url#pair=code&k=<kind>&fp=…&pk=…&host=…&name=…&e=<kind>:<url>…&ca=<url>…`:
 * the fragment never reaches a server log, and the page drops it before
 * rendering. A browser needs only `pair`; a native client reads the rest to
 * pin the key and pick an address. `k` is the kind of the link's own origin;
 * each `ca` names an address (the link's own too) that a CA vouches for.
 */
export function pairingUrl(endpoint: string | PairingEndpoint, payload: Omit<PairingPayload, "endpoints"> & { endpoints?: readonly PairingEndpoint[] }): string {
  const own = typeof endpoint === "string" ? { url: endpoint } : endpoint;
  const base = own.url.replace(/#.*$/u, "");
  const fields = new URLSearchParams({ pair: payload.code });
  if (own.kind) fields.set("k", own.kind);
  const fingerprint = payload.fingerprint ? canonicalFingerprint(payload.fingerprint) : undefined;
  if (fingerprint) fields.set("fp", fingerprint.replace(/:/gu, ""));
  const publicKey = payload.publicKey ? canonicalFingerprint(payload.publicKey) : undefined;
  if (publicKey) fields.set("pk", publicKey.replace(/:/gu, ""));
  if (payload.hostId) fields.set("host", payload.hostId);
  if (payload.hostName) fields.set("name", payload.hostName);
  for (const other of payload.endpoints ?? []) {
    if (other.url !== base) fields.append("e", other.kind ? `${other.kind}:${other.url}` : other.url);
  }
  const trusted = [own, ...(payload.endpoints ?? [])].filter((entry) => entry.trustedCertificate).map((entry) => entry.url.replace(/#.*$/u, ""));
  for (const url of new Set(trusted)) fields.append("ca", url);
  return `${base}#${fields.toString()}`;
}

/** Reads a pairing link, or just its fragment; undefined when it carries no code. */
export function parsePairingPayload(text: string): PairingPayload | undefined {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  const fragment = hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
  const fields = new URLSearchParams(fragment);
  const code = fields.get("pair");
  if (!code) return undefined;
  const endpoints: PairingEndpoint[] = [];
  const add = (url: string, kind?: string | null): void => {
    if (!/^https?:\/\//u.test(url) || endpoints.some((entry) => entry.url === url)) return;
    endpoints.push({ url, ...(isEndpointKind(kind) ? { kind } : {}) });
  };
  if (hash > 0) add(trimmed.slice(0, hash), fields.get("k"));
  for (const entry of fields.getAll("e")) {
    const split = /^([a-z0-9-]+):(https?:\/\/.*)$/u.exec(entry);
    if (split) add(split[2]!, split[1]);
    else add(entry);
  }
  const trusted = new Set(fields.getAll("ca"));
  for (const endpoint of endpoints) if (trusted.has(endpoint.url) && authorityName(endpoint.url)) endpoint.trustedCertificate = true;
  const fingerprint = canonicalFingerprint(fields.get("fp") ?? "");
  const publicKey = canonicalFingerprint(fields.get("pk") ?? "");
  const hostId = fields.get("host");
  const hostName = fields.get("name");
  return {
    code,
    endpoints,
    ...(fingerprint ? { fingerprint } : {}),
    ...(publicKey ? { publicKey } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostName ? { hostName } : {}),
  };
}

/**
 * A URL whose host a public CA can vouch for: a DNS name, not an IP literal
 * and not `.local`. Only such an address may skip the host's pin.
 */
export function authorityName(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (!host || host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return false;
  return host.includes(".") && !host.endsWith(".local") && host !== "localhost";
}

/** `AB:CD:…` from any spelling of 32 bytes of hex; undefined for anything else. */
export function canonicalFingerprint(value: string): string | undefined {
  const hex = value.trim().replace(/^sha-?256[:/=\s]*/iu, "").replace(/[\s:]/gu, "").toUpperCase();
  return /^[0-9A-F]{64}$/u.test(hex) ? hex.match(/.{2}/gu)!.join(":") : undefined;
}

/** Why a socket was closed with 4401; the client words its notice after it. */
export const ACCESS_CLOSE_REASON = {
  unauthorized: "unauthorized",
  revoked: "revoked",
  rotated: "token-rotated",
} as const;
