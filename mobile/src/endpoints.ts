import { authorityName, type PairingEndpoint, type UiHostEndpointKind } from "../../src/shared/connections";

/** What the app pins for a host: its key, or, from before key pins, one certificate. */
export interface HostPins {
  publicKey?: string;
  fingerprint?: string;
}

/** One way to reach a host's socket, in the order the app prefers it. */
export interface SocketCandidate {
  /** `wss://…/`, or `ws://` to a loopback host from a simulator. */
  url: string;
  kind?: UiHostEndpointKind;
  /**
   * `pin`: the host's key (or old certificate) and nothing else; `authority`:
   * a certificate a CA the phone trusts vouches for under this name, as at
   * Tailscale Serve; `plain`: a simulator's loopback without TLS.
   */
  trust: "pin" | "authority" | "plain";
  /** The key to pin, for `pin`. */
  publicKey?: string;
  /** The certificate to pin, for `pin` without a key: a host paired before key pins. */
  fingerprint?: string;
  /** A certificate pin may give way to a CA for a name one can vouch for, as it did before addresses carried the flag. */
  allowAuthority: boolean;
  /** The address is marked as one a CA vouches for: a proxy in front of the host ends TLS there. */
  proxied?: boolean;
  /** Lower is preferred. */
  rank: number;
  /** Opaque TLS relay, separate from the host hello credential. */
  connect?: { url: string; token: string };
}

export interface DeviceNetwork {
  platform: "ios" | "android" | "web";
  /** A simulator or emulator: the development machine's loopback is reachable. */
  virtual: boolean;
}

// The local network first, so a phone at home never depends on Tailscale (plan, decision 2).
const RANK: Record<UiHostEndpointKind, number> = { lan: 0, mdns: 1, tailscale: 3, magicdns: 5, loopback: 9 };
const UNKNOWN_RANK = 6;

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
const isIpLiteral = (host: string): boolean => host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);

/**
 * Every address the app may try for a host, best first. Plain `ws:` is only
 * ever loopback — a host never listens in plaintext beyond it — and loopback
 * is this phone itself, so it counts only in a simulator (the Android
 * emulator reaches the development machine as 10.0.2.2). An address marked
 * as one a CA vouches for is checked by chain and name; every other TLS
 * address is pinned to the host's key.
 */
export function socketCandidates(endpoints: readonly PairingEndpoint[], pins: HostPins, device: DeviceNetwork): SocketCandidate[] {
  const candidates: SocketCandidate[] = [];
  for (const endpoint of endpoints) {
    let url: URL;
    try { url = new URL(endpoint.url); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const loopback = isLoopbackHost(url.hostname) || endpoint.kind === "loopback";
    if (loopback && !device.virtual) continue;
    const tls = url.protocol === "https:";
    if (!tls && !loopback) continue;
    if (loopback && device.platform === "android") url.hostname = "10.0.2.2";
    const kind = endpoint.kind ?? (loopback ? "loopback" : undefined);
    const ipv6 = url.hostname.startsWith("[");
    const socketUrl = `${tls ? "wss" : "ws"}://${url.host}/`;
    if (candidates.some((candidate) => candidate.url === socketUrl)) continue;
    const proxied = tls && endpoint.trustedCertificate === true && authorityName(endpoint.url);
    const pin: HostPins = !tls || proxied ? {} : pins.publicKey ? { publicKey: pins.publicKey } : pins.fingerprint ? { fingerprint: pins.fingerprint } : {};
    const pinned = Boolean(pin.publicKey || pin.fingerprint);
    candidates.push({
      url: socketUrl,
      ...(kind ? { kind } : {}),
      trust: !tls ? "plain" : pinned ? "pin" : "authority",
      ...pin,
      // Only an old certificate pin keeps the CA fallback; a key pin is strict.
      allowAuthority: Boolean(pin.fingerprint) && !isIpLiteral(url.hostname) && !url.hostname.endsWith(".local"),
      ...(proxied ? { proxied: true } : {}),
      // IPv6 after the IPv4 and name of the same network.
      rank: (kind ? RANK[kind] : UNKNOWN_RANK) + (ipv6 ? 1.5 : 0),
    });
  }
  return candidates.sort((a, b) => a.rank - b.rank);
}

/** The socket an attempt opens: a `NativeSocket`, or a fake in tests. */
export interface AttemptSocket {
  readonly readyState: number;
  fingerprint?: string | undefined;
  publicKey?: string | undefined;
  pinMismatch?: boolean;
  /** No pin decided and the platform did not trust the certificate (chain or name). */
  untrustedCertificate?: boolean;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RaceTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RaceOptions {
  /** How long an open socket waits for a better address still trying. */
  graceMs?: number;
  timers?: RaceTimers;
  /** The address that won and what its handshake showed, before the socket reports open. */
  onWinner?(candidate: SocketCandidate, seen: { fingerprint?: string; publicKey?: string }): void;
  /** No address opened. */
  onFailure?(failure: RaceFailure): void;
  /** Every frame the chosen socket receives, before the socket's own handler sees it. */
  onMessage?(data: unknown): void;
}

/**
 * Why no address opened. A wrong key anywhere outranks an untrusted
 * certificate, and either outranks silence: the rest may just be out of
 * reach, but those answered with something this phone must refuse.
 * `addresses` are the ones that did, as `host[:port]`.
 */
export type RaceFailure =
  | { reason: "unreachable" }
  | { reason: "certificate-mismatch" | "untrusted-certificate"; addresses: string[] };

/** A refusal that names what answered: a wrong key or an untrusted certificate. */
export type CertificateRefusal = Exclude<RaceFailure, { reason: "unreachable" }>;

/** `a`, `a and b`, `a, b and c`. */
export function listAddresses(addresses: readonly string[]): string {
  if (addresses.length <= 1) return addresses[0] ?? "";
  return `${addresses.slice(0, -1).join(", ")} and ${addresses[addresses.length - 1]}`;
}

/** `host[:port]` of a socket URL, as the user knows the address. */
export function displayAddress(socketUrl: string): string {
  try { return new URL(socketUrl).host; } catch { return socketUrl; }
}

/** After the first address answers, better ones get this long to answer too. */
export const RACE_GRACE_MS = 400;

const OPEN = 1;
const CLOSED = 3;

/**
 * Tries every candidate at once and becomes the best one that opens: the
 * first open socket wins at once when nothing better is still trying, or
 * after a short grace otherwise. A phone that left home fails the LAN
 * addresses quickly or not at all, and the grace keeps a slow LAN from losing
 * to Tailscale. Shaped like a `WebSocket`, so the host transport opens one per
 * reconnect and a changed network picks again.
 */
export class RacingSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** The candidate that won, once one did. */
  winner: SocketCandidate | undefined;
  /** Why no candidate opened, once none did. */
  failure: RaceFailure | undefined;
  fingerprint: string | undefined;
  publicKey: string | undefined;

  private readonly attempts: Array<{ candidate: SocketCandidate; socket: AttemptSocket; state: "trying" | "open" | "failed" }>;
  private readonly timers: RaceTimers;
  private grace: unknown;
  private graceOver = false;
  private chosen: AttemptSocket | undefined;

  constructor(candidates: readonly SocketCandidate[], open: (candidate: SocketCandidate) => AttemptSocket, private readonly options: RaceOptions = {}) {
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.attempts = candidates.map((candidate) => ({ candidate, socket: open(candidate), state: "trying" as const }));
    for (const attempt of this.attempts) {
      attempt.socket.addEventListener("open", () => {
        if (attempt.state !== "trying") return;
        attempt.state = "open";
        if (this.grace === undefined && !this.graceOver && this.readyState === 0) {
          this.grace = this.timers.setTimeout(() => { this.graceOver = true; this.decide(); }, this.options.graceMs ?? RACE_GRACE_MS);
        }
        this.decide();
      });
      attempt.socket.addEventListener("close", () => {
        if (attempt.state === "failed") return;
        attempt.state = "failed";
        this.decide();
      });
    }
    // Nothing to try is a failure, but reported after the caller set its handlers.
    if (this.attempts.length === 0) queueMicrotask(() => this.decide());
  }

  send(data: string): void {
    if (!this.chosen || this.readyState !== OPEN) throw new Error("The socket is not open.");
    this.chosen.send(data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    if (this.chosen) { this.chosen.close(); return; }
    this.finish();
    for (const attempt of this.attempts) if (attempt.state !== "failed") attempt.socket.close();
    this.onclose?.({ code: 1000 });
  }

  private decide(): void {
    if (this.readyState !== 0) return;
    const best = this.attempts.find((attempt) => attempt.state !== "failed");
    if (!best) {
      const failure = this.failureOf();
      this.failure = failure;
      this.finish();
      this.options.onFailure?.(failure);
      this.onclose?.({ code: 1006, reason: failure.reason });
      return;
    }
    if (best.state === "open") { this.win(best); return; }
    if (this.graceOver) {
      const open = this.attempts.find((attempt) => attempt.state === "open");
      if (open) this.win(open);
    }
  }

  private failureOf(): RaceFailure {
    const refused = (test: (socket: AttemptSocket) => boolean) =>
      [...new Set(this.attempts.filter((attempt) => test(attempt.socket)).map((attempt) => displayAddress(attempt.candidate.url)))];
    const mismatched = refused((socket) => socket.pinMismatch === true);
    if (mismatched.length > 0) return { reason: "certificate-mismatch", addresses: mismatched };
    const untrusted = refused((socket) => socket.untrustedCertificate === true);
    if (untrusted.length > 0) return { reason: "untrusted-certificate", addresses: untrusted };
    return { reason: "unreachable" };
  }

  private win(attempt: (typeof this.attempts)[number]): void {
    this.timers.clearTimeout(this.grace);
    // Settled before the losers close: their close events re-enter `decide`.
    this.chosen = attempt.socket;
    this.winner = attempt.candidate;
    this.fingerprint = attempt.socket.fingerprint;
    this.publicKey = attempt.socket.publicKey;
    this.readyState = OPEN;
    for (const other of this.attempts) if (other !== attempt && other.state !== "failed") other.socket.close();
    this.options.onWinner?.(attempt.candidate, {
      ...(this.fingerprint ? { fingerprint: this.fingerprint } : {}),
      ...(this.publicKey ? { publicKey: this.publicKey } : {}),
    });
    attempt.socket.addEventListener("message", (event) => {
      this.options.onMessage?.(event.data);
      this.onmessage?.({ data: event.data });
    });
    attempt.socket.addEventListener("close", (event) => {
      this.readyState = CLOSED;
      this.onclose?.({ ...(event.code !== undefined ? { code: event.code } : {}), ...(event.reason ? { reason: event.reason } : {}) });
    });
    this.onopen?.();
  }

  private finish(): void {
    this.timers.clearTimeout(this.grace);
    this.readyState = CLOSED;
  }
}
