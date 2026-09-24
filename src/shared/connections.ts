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
  /** The address it last connected from; behind a proxy this is the proxy. */
  lastAddress?: string;
  /** Open connections with this client's token right now. */
  connections: number;
  /** The connection asking is this client. */
  current: boolean;
  access: DeviceAccess;
  idleTimeoutDays: IdleTimeoutDays;
  /** When the token stops working unless the device connects before; absent when it never does. */
  expiresAt?: string;
  /** The last thing it changed on the host: a method or `<extension>/<command>`, never its input. */
  lastAction?: { action: string; at: string };
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
  createdAt: string;
  expiresAt: string;
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

/** Where a client can reach this host, as a URL a browser opens. */
export interface UiHostEndpoint {
  url: string;
  label: string;
  /** Loopback is reachable only from this machine, so it is never offered as a QR code. */
  reachability: "loopback" | "network";
}

export interface UiConnections {
  /** This host's stable id, the same in a pairing link and (later) a Bonjour record. */
  hostId?: string;
  scheme: "ws" | "wss";
  endpoints: UiHostEndpoint[];
  /** The browser client is built and served; without it a pairing link has nothing to open. */
  webClient: boolean;
  /** SHA-256 of the TLS certificate, for comparing with the browser's warning. */
  fingerprint?: string;
  tokenPath: string;
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

/** What the owner may change about a paired device. */
export interface UiClientUpdate {
  label?: string;
  access?: DeviceAccess;
  idleTimeoutDays?: IdleTimeoutDays;
}

/** How long a new pairing link may be redeemed; the host clamps anything else. */
export const PAIRING_LINK_LIFETIMES_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

/** What a pairing link or QR code tells a device, besides where the link itself points. */
export interface PairingPayload {
  code: string;
  /** SHA-256 of the host's own certificate, `AB:CD:…`; a device pins it on every endpoint that presents a self-signed one. */
  fingerprint?: string;
  hostId?: string;
  hostName?: string;
  /** Every address the host listens on, best first; the link's own origin leads. */
  endpoints: string[];
}

/**
 * `url#pair=code&fp=…&host=…&name=…&e=…`: the fragment never reaches a server
 * log, and the page drops it before rendering. A browser needs only `pair`;
 * a native client reads the rest to pin the certificate and pick an address.
 */
export function pairingUrl(endpointUrl: string, payload: Omit<PairingPayload, "endpoints"> & { endpoints?: readonly string[] }): string {
  const base = endpointUrl.replace(/#.*$/u, "");
  const fields = new URLSearchParams({ pair: payload.code });
  const fingerprint = payload.fingerprint ? canonicalFingerprint(payload.fingerprint) : undefined;
  if (fingerprint) fields.set("fp", fingerprint.replace(/:/gu, ""));
  if (payload.hostId) fields.set("host", payload.hostId);
  if (payload.hostName) fields.set("name", payload.hostName);
  for (const endpoint of payload.endpoints ?? []) if (endpoint !== base) fields.append("e", endpoint);
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
  const endpoints: string[] = [];
  const origin = hash > 0 ? trimmed.slice(0, hash) : "";
  if (/^https?:\/\//u.test(origin)) endpoints.push(origin);
  for (const endpoint of fields.getAll("e")) {
    if (/^https?:\/\//u.test(endpoint) && !endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  const fingerprint = canonicalFingerprint(fields.get("fp") ?? "");
  const hostId = fields.get("host");
  const hostName = fields.get("name");
  return {
    code,
    endpoints,
    ...(fingerprint ? { fingerprint } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostName ? { hostName } : {}),
  };
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
