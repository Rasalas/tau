import { isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { X509Certificate } from "node:crypto";
import { fingerprintsMatch, normalizeFingerprint, publicKeyPin } from "./host-tls.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/**
 * How a client trusts the host at `TAU_HOST_URL`. A `ws:` URL is plaintext
 * (loopback or a tunnel); a `wss:` host is either verified by a CA the
 * machine trusts, or pinned to the SHA-256 fingerprint of its certificate.
 */
export type HostTrust =
  | { kind: "plain" }
  | { kind: "authority"; hostname: string }
  | { kind: "pinned"; hostname: string; fingerprint: string; source: "environment" | "known-host" | "confirmed" };

export interface HostEndpoint {
  hostname: string;
  port: number;
  /** `hostname:port`, the known-hosts key. */
  key: string;
}

export function hostEndpoint(url: string): HostEndpoint {
  const parsed = new URL(url);
  const hostname = bareHost(parsed.hostname);
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  return { hostname, port, key: `${hostname}:${port}` };
}

function bareHost(host: string): string {
  return host.replace(/^\[|\]$/gu, "").toLowerCase();
}

/**
 * What a client accepts from one address. `publicKey` pins the key (SPKI
 * SHA-256) and survives the host renewing its certificate; `fingerprint`
 * pins one certificate, as clients did before key pins. With neither the
 * address needs a certificate a CA the machine trusts vouches for.
 */
export interface HostPin {
  publicKey?: string;
  fingerprint?: string;
}

/** A certificate as a pin compares it. */
export interface PresentedIdentity {
  fingerprint: string;
  publicKey: string;
}

export function presentedIdentity(certificate: X509Certificate): PresentedIdentity {
  return { fingerprint: certificate.fingerprint256, publicKey: publicKeyPin(certificate) };
}

/** A key pin decides when there is one; a certificate pin only without it. */
export function pinAccepts(pin: HostPin, presented: PresentedIdentity): boolean {
  if (pin.publicKey) return fingerprintsMatch(presented.publicKey, pin.publicKey);
  return pin.fingerprint !== undefined && fingerprintsMatch(presented.fingerprint, pin.fingerprint);
}

export function isPinned(pin: HostPin | undefined): pin is HostPin {
  return Boolean(pin?.publicKey || pin?.fingerprint);
}

/** A pinned host presented another certificate. Never retried: a reconnect would meet the same one. */
export class HostCertificateRefusedError extends Error {
  constructor(readonly presented: string, readonly expected: string, readonly kind: "certificate" | "key" = "certificate") {
    super(kind === "key"
      ? `The host presented a certificate whose key has SHA-256 ${presented}, not the pinned ${expected}.`
      : `The host presented a certificate with SHA-256 fingerprint ${presented}, not the pinned ${expected}.`);
    this.name = "HostCertificateRefusedError";
  }
}

/**
 * A `createConnection` for `ws` that accepts exactly one key (or, for an old
 * pin, one certificate). The chain is not checked — a self-signed host has
 * none — but the pin is, and a mismatch destroys the socket before the
 * WebSocket opens, so no hello and no token ever reach it. `onPresented`
 * hears what an accepted connection showed.
 */
export function pinnedTlsConnect(
  expected: string | HostPin,
  onPresented?: (presented: PresentedIdentity) => void,
): (options: ConnectionOptions & { path?: string }) => TLSSocket {
  const pin: HostPin = typeof expected === "string" ? { fingerprint: expected } : expected;
  return (options) => {
    const host = options.host ?? "";
    const socket = tlsConnect({
      ...options,
      // `https.request` passes its request path, which tls.connect would take for an IPC path.
      path: undefined,
      servername: options.servername ?? (isIP(host) ? "" : host),
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    } as ConnectionOptions);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerX509Certificate();
      const presented = certificate ? presentedIdentity(certificate) : undefined;
      if (presented && pinAccepts(pin, presented)) {
        onPresented?.(presented);
        return;
      }
      socket.destroy(pin.publicKey
        ? new HostCertificateRefusedError(presented?.publicKey ?? "(none)", normalizeFingerprint(pin.publicKey) ?? pin.publicKey, "key")
        : new HostCertificateRefusedError(presented?.fingerprint ?? "(none)", normalizeFingerprint(pin.fingerprint ?? "") ?? pin.fingerprint ?? "", "certificate"));
    });
    return socket;
  };
}

/**
 * A `createConnection` for an address whose certificate a CA vouches for
 * (Tailscale Serve): the chain and the name are checked, nothing is pinned.
 * `ca` replaces the machine's authorities; tests pass their own.
 */
export function authorityTlsConnect(ca?: string | string[]): (options: ConnectionOptions & { path?: string }) => TLSSocket {
  return (options) => {
    const host = options.host ?? "";
    return tlsConnect({
      ...options,
      path: undefined,
      servername: options.servername ?? (isIP(host) ? "" : host),
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    } as ConnectionOptions);
  };
}

/** The connection factory one address needs: pinned, or verified by a CA. */
export function hostTlsConnect(pin: HostPin | undefined, onPresented?: (presented: PresentedIdentity) => void): (options: ConnectionOptions & { path?: string }) => TLSSocket {
  return isPinned(pin) ? pinnedTlsConnect(pin, onPresented) : authorityTlsConnect();
}

/** What a host shows before anything is sent: enough to ask the user about it. */
export interface PresentedCertificate {
  fingerprint: string;
  /** SHA-256 of its public key, the pin a client keeps. */
  publicKey: string;
  /** Valid for this name under a CA the machine trusts. */
  authorized: boolean;
  authorizationError?: string;
  subject: string;
  validTo: string;
}

/** Completes a TLS handshake and hangs up; nothing of the protocol is spoken. */
export function probeHostCertificate(url: string, timeoutMs = 5_000): Promise<PresentedCertificate> {
  const { hostname, port } = hostEndpoint(url);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: hostname, port, servername: isIP(hostname) ? "" : hostname, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    const timer = setTimeout(() => socket.destroy(new Error(`No TLS handshake with ${hostname}:${port} within ${timeoutMs}ms.`)), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const certificate = socket.getPeerX509Certificate();
      const authorizationError = socket.authorizationError ? String(socket.authorizationError) : undefined;
      socket.end();
      if (!certificate) { reject(new Error(`${hostname}:${port} presented no certificate.`)); return; }
      resolve({
        ...presentedIdentity(certificate),
        authorized: socket.authorized,
        ...(authorizationError ? { authorizationError } : {}),
        subject: certificate.subject,
        validTo: certificate.validTo,
      });
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

interface KnownHostEntry {
  fingerprint: string;
  trustedAt: string;
}

const KNOWN_HOSTS_VERSION = 1;

/** `<userData>/known-hosts.json`: the fingerprints this client was told to trust. */
export class KnownHosts {
  constructor(readonly path: string, private readonly logger?: PersistedJsonLogger) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key]?.fingerprint;
  }

  async remember(key: string, fingerprint: string): Promise<void> {
    const hosts = await this.read();
    hosts[key] = { fingerprint, trustedAt: new Date().toISOString() };
    await writePersistedJson(this.path, KNOWN_HOSTS_VERSION, { hosts }, this.logger ? { logger: this.logger } : {});
  }

  private async read(): Promise<Record<string, KnownHostEntry>> {
    const stored = await readPersistedJson(this.path, {
      expectedVersion: KNOWN_HOSTS_VERSION,
      decode: decodeKnownHosts,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    return stored?.data ?? {};
  }
}

function decodeKnownHosts(value: unknown): Record<string, KnownHostEntry> | undefined {
  const hosts = (value as { hosts?: unknown } | undefined)?.hosts;
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return undefined;
  const entries: Record<string, KnownHostEntry> = {};
  for (const [key, entry] of Object.entries(hosts as Record<string, unknown>)) {
    const fingerprint = normalizeFingerprint(String((entry as { fingerprint?: unknown })?.fingerprint ?? ""));
    const trustedAt = (entry as { trustedAt?: unknown })?.trustedAt;
    if (fingerprint) entries[key] = { fingerprint, trustedAt: typeof trustedAt === "string" ? trustedAt : "" };
  }
  return entries;
}

/** Why a host is not trusted. The message is written for a dialog. */
export class HostTrustError extends Error {
  constructor(readonly reason: "invalid-fingerprint" | "unreachable" | "declined", message: string) {
    super(message);
    this.name = "HostTrustError";
  }
}

export interface EstablishHostTrustOptions {
  /** `TAU_HOST_FINGERPRINT`: the certificate the operator says the host has. */
  fingerprint?: string;
  knownHosts: KnownHosts;
  /** Trust on first use needs a yes from the user; anything else is a no. */
  confirm(request: { url: string; endpoint: HostEndpoint; presented: PresentedCertificate }): Promise<boolean>;
  probe?(url: string): Promise<PresentedCertificate>;
}

/**
 * Decides how to trust the host before the window connects. A pin from the
 * environment or from known-hosts is taken as is: the connection enforces it,
 * so a mismatch surfaces there. A host with neither is shown to the user once,
 * unless a CA the machine trusts already vouches for it.
 */
export async function establishHostTrust(url: string, options: EstablishHostTrustOptions): Promise<HostTrust> {
  if (!url.startsWith("wss:")) return { kind: "plain" };
  const endpoint = hostEndpoint(url);
  if (options.fingerprint?.trim()) {
    const fingerprint = normalizeFingerprint(options.fingerprint);
    if (!fingerprint) {
      throw new HostTrustError("invalid-fingerprint", "TAU_HOST_FINGERPRINT is not a SHA-256 fingerprint (64 hex digits, colons optional).");
    }
    return { kind: "pinned", hostname: endpoint.hostname, fingerprint, source: "environment" };
  }
  const known = await options.knownHosts.get(endpoint.key);
  if (known) return { kind: "pinned", hostname: endpoint.hostname, fingerprint: known, source: "known-host" };

  let presented: PresentedCertificate;
  try {
    presented = await (options.probe ?? probeHostCertificate)(url);
  } catch (error: unknown) {
    throw new HostTrustError("unreachable", `Tau could not read the certificate of ${endpoint.key}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (presented.authorized) return { kind: "authority", hostname: endpoint.hostname };
  if (!await options.confirm({ url, endpoint, presented })) {
    throw new HostTrustError("declined", `The certificate of ${endpoint.key} was not trusted, so Tau did not connect.`);
  }
  await options.knownHosts.remember(endpoint.key, presented.fingerprint);
  return { kind: "pinned", hostname: endpoint.hostname, fingerprint: presented.fingerprint, source: "confirmed" };
}

/** Chromium's verdicts for `session.setCertificateVerifyProc`. */
export const CERTIFICATE_ACCEPT = 0;
export const CERTIFICATE_REJECT = -2;
export const CERTIFICATE_DEFAULT = -3;

/**
 * The window's verdict on a certificate Chromium met. Only the pinned host is
 * decided here; every other name keeps Chromium's own verification.
 */
export function certificateVerdict(
  trust: HostTrust,
  hostname: string,
  presentedFingerprint: string,
): typeof CERTIFICATE_ACCEPT | typeof CERTIFICATE_REJECT | typeof CERTIFICATE_DEFAULT {
  if (trust.kind !== "pinned" || bareHost(hostname) !== trust.hostname) return CERTIFICATE_DEFAULT;
  return fingerprintsMatch(presentedFingerprint, trust.fingerprint) ? CERTIFICATE_ACCEPT : CERTIFICATE_REJECT;
}

/** What the user reads when a pinned host shows another certificate. */
export function certificateRefusalMessage(url: string, trust: HostTrust, presented: string, knownHostsPath: string): string {
  const expected = trust.kind === "pinned" ? trust.fingerprint : "(none)";
  const repair = trust.kind === "pinned" && trust.source === "environment"
    ? "If the host's certificate was replaced on purpose, update TAU_HOST_FINGERPRINT."
    : `If the host's certificate was replaced on purpose, remove the entry for ${hostEndpoint(url).key} from ${knownHostsPath} and connect again.`;
  return [
    `The host at ${url} presented a certificate this client does not trust.`,
    "",
    `Expected SHA-256: ${expected}`,
    `Presented SHA-256: ${presented}`,
    "",
    "Someone may be intercepting the connection. Tau did not send the host token.",
    repair,
  ].join("\n");
}
