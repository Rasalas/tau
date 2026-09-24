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
  /** The address it last connected from; behind a proxy this is the proxy. */
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

/** Where a client can reach this host, as a URL a browser opens. */
export interface UiHostEndpoint {
  url: string;
  label: string;
  /** Loopback is reachable only from this machine, so it is never offered as a QR code. */
  reachability: "loopback" | "network";
}

export interface UiConnections {
  scheme: "ws" | "wss";
  endpoints: UiHostEndpoint[];
  /** The browser client is built and served; without it a pairing link has nothing to open. */
  webClient: boolean;
  /** SHA-256 of the TLS certificate, for comparing with the browser's warning. */
  fingerprint?: string;
  tokenPath: string;
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
