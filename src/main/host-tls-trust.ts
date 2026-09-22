import { isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { fingerprintsMatch, normalizeFingerprint } from "./host-tls.js";
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

/** A pinned host presented another certificate. Never retried: a reconnect would meet the same one. */
export class HostCertificateRefusedError extends Error {
  constructor(readonly presented: string, readonly expected: string) {
    super(`The host presented a certificate with SHA-256 fingerprint ${presented}, not the pinned ${expected}.`);
    this.name = "HostCertificateRefusedError";
  }
}

/**
 * A `createConnection` for `ws` that accepts exactly one certificate. The chain
 * is not checked — a self-signed host has none — but the fingerprint is, and a
 * mismatch destroys the socket before the WebSocket opens, so no hello and no
 * token ever reach it.
 */
export function pinnedTlsConnect(expected: string): (options: ConnectionOptions & { path?: string }) => TLSSocket {
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
      const presented = socket.getPeerX509Certificate()?.fingerprint256 ?? "(none)";
      if (!fingerprintsMatch(presented, expected)) socket.destroy(new HostCertificateRefusedError(presented, normalizeFingerprint(expected) ?? expected));
    });
    return socket;
  };
}

/** What a host shows before anything is sent: enough to ask the user about it. */
export interface PresentedCertificate {
  fingerprint: string;
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
        fingerprint: certificate.fingerprint256,
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
