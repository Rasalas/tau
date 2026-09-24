import type { PairingEndpoint, UiHostEndpointKind } from "../../src/shared/connections";

/** One way to reach a host's socket, in the order the app prefers it. */
export interface SocketCandidate {
  /** `wss://…/`, or `ws://` to a loopback host from a simulator. */
  url: string;
  kind?: UiHostEndpointKind;
  /** The certificate to pin, when the host gave one and this is TLS. */
  fingerprint?: string;
  /** A name a public CA can vouch for (Tailscale Serve), where a trusted certificate is as good as the pin. */
  allowAuthority: boolean;
  /** Lower is preferred. */
  rank: number;
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
 * emulator reaches the development machine as 10.0.2.2).
 */
export function socketCandidates(endpoints: readonly PairingEndpoint[], fingerprint: string | undefined, device: DeviceNetwork): SocketCandidate[] {
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
    candidates.push({
      url: socketUrl,
      ...(kind ? { kind } : {}),
      ...(tls && fingerprint ? { fingerprint } : {}),
      allowAuthority: tls && !isIpLiteral(url.hostname) && !url.hostname.endsWith(".local"),
      rank: (kind ? RANK[kind] : UNKNOWN_RANK) + (ipv6 ? 1 : 0),
    });
  }
  return candidates.sort((a, b) => a.rank - b.rank);
}

/** The socket an attempt opens: a `NativeSocket`, or a fake in tests. */
export interface AttemptSocket {
  readonly readyState: number;
  fingerprint?: string;
  pinMismatch?: boolean;
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
  /** The address that won, before the socket reports open. */
  onWinner?(candidate: SocketCandidate): void;
  /** No address opened; `certificate-mismatch` when every one showed another certificate. */
  onFailure?(reason: "unreachable" | "certificate-mismatch"): void;
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
  /** Every candidate refused the pinned certificate. */
  pinMismatch = false;
  fingerprint: string | undefined;

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
      this.pinMismatch = this.attempts.length > 0 && this.attempts.every((attempt) => attempt.socket.pinMismatch === true);
      this.finish();
      const reason = this.pinMismatch ? "certificate-mismatch" : "unreachable";
      this.options.onFailure?.(reason);
      this.onclose?.({ code: 1006, reason });
      return;
    }
    if (best.state === "open") { this.win(best); return; }
    if (this.graceOver) {
      const open = this.attempts.find((attempt) => attempt.state === "open");
      if (open) this.win(open);
    }
  }

  private win(attempt: (typeof this.attempts)[number]): void {
    this.timers.clearTimeout(this.grace);
    for (const other of this.attempts) if (other !== attempt && other.state !== "failed") other.socket.close();
    this.chosen = attempt.socket;
    this.winner = attempt.candidate;
    this.fingerprint = attempt.socket.fingerprint;
    this.readyState = OPEN;
    this.options.onWinner?.(attempt.candidate);
    attempt.socket.addEventListener("message", (event) => this.onmessage?.({ data: event.data }));
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
