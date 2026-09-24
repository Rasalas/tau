import { isIP } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { X509Certificate } from "node:crypto";
import { fingerprintsMatch, normalizeFingerprint, publicKeyPin } from "./host-tls.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/**
 * How a client trusts the host at `TAU_HOST_URL`. A `ws:` URL is plaintext
 * (loopback or a tunnel); a `wss:` host is either verified by a CA the
 * machine trusts, or pinned to its key (or, for an old pin, one certificate).
 */
export type HostTrust =
  | { kind: "plain" }
  | { kind: "authority"; hostname: string }
  | { kind: "pinned"; hostname: string; pin: HostPin; source: "environment" | "known-host" | "confirmed" };

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

/** What the TLS handshake of a connection showed, and whether a pin or a CA let it in. */
export interface ReachedCertificate {
  presented: PresentedIdentity;
  via: "pin" | "authority";
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
 * hears what an accepted connection showed and whether the pin or a CA let
 * it in. `allowAuthority` also accepts a certificate a CA the machine trusts
 * vouches for under this name: only for a saved machine whose addresses
 * predate the per-address flag (F19), until its host lists them again.
 */
export function pinnedTlsConnect(
  expected: string | HostPin,
  onPresented?: (presented: PresentedIdentity, via: "pin" | "authority") => void,
  options: { allowAuthority?: boolean } = {},
): (options: ConnectionOptions & { path?: string }) => TLSSocket {
  const pin: HostPin = typeof expected === "string" ? { fingerprint: expected } : expected;
  const allowAuthority = options.allowAuthority === true;
  return (connectOptions) => {
    const host = connectOptions.host ?? "";
    const servername = connectOptions.servername ?? (isIP(host) ? "" : host);
    const socket = tlsConnect({
      ...connectOptions,
      // `https.request` passes its request path, which tls.connect would take for an IPC path.
      path: undefined,
      servername,
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    } as ConnectionOptions);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerX509Certificate();
      const presented = certificate ? presentedIdentity(certificate) : undefined;
      if (presented && pinAccepts(pin, presented)) {
        onPresented?.(presented, "pin");
        return;
      }
      // Chain and name, as rejectUnauthorized would have checked them.
      if (presented && allowAuthority && servername && socket.authorized && !checkServerIdentity(servername, socket.getPeerCertificate())) {
        onPresented?.(presented, "authority");
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

/**
 * How a client trusts one `wss:` address: a pin (perhaps with the old
 * CA fallback), or, with no pin at all, a CA the machine trusts.
 */
export interface EndpointTrust {
  pin?: HostPin;
  allowAuthority?: boolean;
}

/** The connection factory one address needs: pinned, or verified by a CA. */
export function hostTlsConnect(
  trust: EndpointTrust | undefined,
  onPresented?: (presented: PresentedIdentity, via: "pin" | "authority") => void,
): (options: ConnectionOptions & { path?: string }) => TLSSocket {
  return isPinned(trust?.pin) ? pinnedTlsConnect(trust.pin, onPresented, { allowAuthority: trust.allowAuthority === true }) : authorityTlsConnect();
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

interface KnownHostEntry extends HostPin {
  trustedAt: string;
}

const KNOWN_HOSTS_VERSION = 1;

/**
 * `<userData>/known-hosts.json`: the hosts this client was told to trust. An
 * entry holds the host's key, or one certificate from before key pins until
 * the next connection it lets in moves it to the key.
 */
export class KnownHosts {
  constructor(readonly path: string, private readonly logger?: PersistedJsonLogger) {}

  async get(key: string): Promise<HostPin | undefined> {
    const entry = (await this.read())[key];
    if (!entry) return undefined;
    return entry.publicKey ? { publicKey: entry.publicKey } : { fingerprint: entry.fingerprint! };
  }

  async remember(key: string, pin: HostPin): Promise<void> {
    const hosts = await this.read();
    const trustedAt = new Date().toISOString();
    hosts[key] = pin.publicKey ? { publicKey: pin.publicKey, trustedAt } : { fingerprint: pin.fingerprint!, trustedAt };
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
    const fields = (entry ?? {}) as { publicKey?: unknown; fingerprint?: unknown; trustedAt?: unknown };
    const publicKey = normalizeFingerprint(String(fields.publicKey ?? ""));
    const fingerprint = normalizeFingerprint(String(fields.fingerprint ?? ""));
    const trustedAt = typeof fields.trustedAt === "string" ? fields.trustedAt : "";
    if (publicKey) entries[key] = { publicKey, trustedAt };
    else if (fingerprint) entries[key] = { fingerprint, trustedAt };
  }
  return entries;
}

/**
 * A key pin as an operator writes it: the hex the host prints
 * (`tls public key: SHA256 …`), or `sha256/<base64>` as curl's
 * `--pinnedpubkey` and `openssl … | base64` spell it.
 */
export function normalizeKeyPin(value: string): string | undefined {
  const base64 = /^sha256\/{1,2}([A-Za-z0-9+/]{43}=)$/iu.exec(value.trim());
  if (!base64) return normalizeFingerprint(value);
  const digest = Buffer.from(base64[1]!, "base64");
  return digest.length === 32 ? digest.toString("hex").toUpperCase().match(/.{2}/gu)!.join(":") : undefined;
}

/** A `sha256/<base64>` value names a key; hex names a certificate, as it always did. */
function isBase64KeyPin(value: string): boolean {
  return /^sha256\/{1,2}[A-Za-z0-9+/]{43}=$/iu.test(value.trim());
}

/** Why a host is not trusted. The message is written for a dialog. */
export class HostTrustError extends Error {
  constructor(readonly reason: "invalid-fingerprint" | "invalid-public-key" | "unreachable" | "declined", message: string) {
    super(message);
    this.name = "HostTrustError";
  }
}

export interface EstablishHostTrustOptions {
  /** `TAU_HOST_PUBLIC_KEY`: the key the operator says the host has. */
  publicKey?: string;
  /** `TAU_HOST_FINGERPRINT`: the certificate, or in `sha256/<base64>` form the key. */
  fingerprint?: string;
  knownHosts: KnownHosts;
  /** Trust on first use needs a yes from the user; anything else is a no. */
  confirm(request: { url: string; endpoint: HostEndpoint; presented: PresentedCertificate }): Promise<boolean>;
  probe?(url: string): Promise<PresentedCertificate>;
}

/** The pin the environment names, if any; a malformed value is an error, never ignored. */
export function environmentPin(options: Pick<EstablishHostTrustOptions, "publicKey" | "fingerprint">): HostPin | undefined {
  const pin: HostPin = {};
  const keyText = options.publicKey?.trim();
  const certificateText = options.fingerprint?.trim();
  if (keyText) {
    const publicKey = normalizeKeyPin(keyText);
    if (!publicKey) throw new HostTrustError("invalid-public-key", "TAU_HOST_PUBLIC_KEY is not a SHA-256 key pin (64 hex digits, colons optional, or sha256/<base64>).");
    pin.publicKey = publicKey;
  }
  if (certificateText) {
    if (isBase64KeyPin(certificateText)) {
      pin.publicKey ??= normalizeKeyPin(certificateText)!;
    } else {
      const fingerprint = normalizeFingerprint(certificateText);
      if (!fingerprint) throw new HostTrustError("invalid-fingerprint", "TAU_HOST_FINGERPRINT is not a SHA-256 fingerprint (64 hex digits, colons optional).");
      if (!pin.publicKey) pin.fingerprint = fingerprint;
    }
  }
  return isPinned(pin) ? pin : undefined;
}

/**
 * Decides how to trust the host before the window connects. A pin from the
 * environment or from known-hosts is taken as is: the connection enforces it,
 * so a mismatch surfaces there. A host with neither is shown to the user once,
 * unless a CA the machine trusts already vouches for it; a yes pins its key.
 */
export async function establishHostTrust(url: string, options: EstablishHostTrustOptions): Promise<HostTrust> {
  if (!url.startsWith("wss:")) return { kind: "plain" };
  const endpoint = hostEndpoint(url);
  const fromEnvironment = environmentPin(options);
  if (fromEnvironment) return { kind: "pinned", hostname: endpoint.hostname, pin: fromEnvironment, source: "environment" };
  const known = await options.knownHosts.get(endpoint.key);
  if (known) return { kind: "pinned", hostname: endpoint.hostname, pin: known, source: "known-host" };

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
  const pin = { publicKey: presented.publicKey };
  await options.knownHosts.remember(endpoint.key, pin);
  return { kind: "pinned", hostname: endpoint.hostname, pin, source: "confirmed" };
}

/**
 * The known-hosts pin a connection teaches: a certificate pin that just let
 * a connection in becomes that certificate's key. Nothing else migrates — an
 * environment pin is the operator's, and a key pin is already one.
 */
export function migratedKnownHostPin(trust: HostTrust, certificate: ReachedCertificate | undefined): HostPin | undefined {
  if (trust.kind !== "pinned" || trust.source === "environment" || trust.pin.publicKey || certificate?.via !== "pin") return undefined;
  return { publicKey: certificate.presented.publicKey };
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
  presented: PresentedIdentity,
): typeof CERTIFICATE_ACCEPT | typeof CERTIFICATE_REJECT | typeof CERTIFICATE_DEFAULT {
  if (trust.kind !== "pinned" || bareHost(hostname) !== trust.hostname) return CERTIFICATE_DEFAULT;
  return pinAccepts(trust.pin, presented) ? CERTIFICATE_ACCEPT : CERTIFICATE_REJECT;
}

/** What the user reads when a pinned host shows another key or certificate. */
export function certificateRefusalMessage(url: string, trust: HostTrust, presented: PresentedIdentity | string, knownHostsPath: string): string {
  const pin = trust.kind === "pinned" ? trust.pin : {};
  const byKey = Boolean(pin.publicKey);
  const shown = typeof presented === "string" ? presented : byKey ? presented.publicKey : presented.fingerprint;
  const expected = (byKey ? pin.publicKey : pin.fingerprint) ?? "(none)";
  const environment = trust.kind === "pinned" && trust.source === "environment";
  const repair = environment
    ? byKey
      ? "If the host's key was replaced on purpose, update TAU_HOST_PUBLIC_KEY."
      : "If the host's certificate was replaced on purpose, update TAU_HOST_FINGERPRINT, or pin its key with TAU_HOST_PUBLIC_KEY, which a renewal keeps."
    : `If the host's ${byKey ? "key" : "certificate"} was replaced on purpose, remove the entry for ${hostEndpoint(url).key} from ${knownHostsPath} and connect again.`;
  return [
    `The host at ${url} presented a certificate this client does not trust.`,
    "",
    `Expected ${byKey ? "key " : ""}SHA-256: ${expected}`,
    `Presented ${byKey ? "key " : ""}SHA-256: ${shown}`,
    "",
    byKey
      ? "A renewed certificate keeps the key, so someone may be intercepting the connection. Tau did not send the host token."
      : "Someone may be intercepting the connection. Tau did not send the host token.",
    repair,
  ].join("\n");
}
