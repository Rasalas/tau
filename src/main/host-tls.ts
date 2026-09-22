import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";

/** The server side of TLS; the socket transport and the web client share one. */
export interface HostTlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 of the leaf certificate, `AB:CD:…` — what a client pins. */
  fingerprint: string;
  source: "self-signed" | "supplied";
  certPath: string;
  keyPath: string;
  /** A self-signed certificate was made during this call; clients that pinned the old one will refuse it. */
  created: boolean;
  /** Things the operator should hear about, such as a key others may read. */
  warnings: string[];
}

export interface HostTlsEnvironment {
  TAU_HOST_TLS?: string;
  TAU_HOST_TLS_CERT?: string;
  TAU_HOST_TLS_KEY?: string;
}

export interface ResolveHostTlsOptions {
  /** Where a self-signed certificate is kept: `<userData>/tls/`. */
  userData: string;
  /** The listen host; named in the certificate when it is a concrete address. */
  bindHost?: string;
  now?: Date;
}

/** Apple's ceiling for any TLS server certificate. */
const SELF_SIGNED_DAYS = 825;
/** Renewed this long before it runs out, so no client ever meets an expired one. */
const RENEW_BEFORE_MS = 7 * 86_400_000;

/**
 * The TLS configuration `TAU_HOST_TLS`, `TAU_HOST_TLS_CERT` and
 * `TAU_HOST_TLS_KEY` ask for, or undefined for a plaintext host. A supplied
 * pair wins; `TAU_HOST_TLS=1` alone means a self-signed certificate kept under
 * userData and reused across restarts, so its fingerprint stays pinnable.
 */
export function resolveHostTls(env: HostTlsEnvironment, options: ResolveHostTlsOptions): HostTlsMaterial | undefined {
  const certPath = env.TAU_HOST_TLS_CERT?.trim();
  const keyPath = env.TAU_HOST_TLS_KEY?.trim();
  if (certPath || keyPath) {
    if (!certPath || !keyPath) throw new Error("TAU_HOST_TLS_CERT and TAU_HOST_TLS_KEY name a certificate and its key; set both.");
    return loadSuppliedTls(certPath, keyPath);
  }
  if (env.TAU_HOST_TLS?.trim() !== "1") return undefined;
  return loadOrCreateSelfSignedTls(join(options.userData, "tls"), options);
}

function loadSuppliedTls(certPath: string, keyPath: string): HostTlsMaterial {
  const cert = readFileSync(certPath, "utf8");
  const key = readFileSync(keyPath, "utf8");
  const leaf = parseCertificate(cert, certPath);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error(`${keyPath} is not the key of the certificate in ${certPath}.`);
  const warnings: string[] = [];
  if (process.platform !== "win32" && (statSync(keyPath).mode & 0o077) !== 0) {
    warnings.push(`${keyPath} is readable by other users; chmod 600 it.`);
  }
  if (Date.parse(leaf.validTo) < Date.now()) warnings.push(`The certificate in ${certPath} expired on ${leaf.validTo}.`);
  return { cert, key, fingerprint: leaf.fingerprint256, source: "supplied", certPath, keyPath, created: false, warnings };
}

function loadOrCreateSelfSignedTls(directory: string, options: ResolveHostTlsOptions): HostTlsMaterial {
  const certPath = join(directory, "host-cert.pem");
  const keyPath = join(directory, "host-key.pem");
  const now = options.now ?? new Date();
  const existing = readSelfSigned(certPath, keyPath, now);
  if (existing) return { ...existing, source: "self-signed", certPath, keyPath, created: false, warnings: [] };

  const { cert, key } = createSelfSignedCertificate({
    commonName: "Tau host",
    ...subjectNames(options.bindHost),
    days: SELF_SIGNED_DAYS,
    now,
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writePrivate(keyPath, key);
  writePrivate(certPath, cert);
  return { cert, key, fingerprint: new X509Certificate(cert).fingerprint256, source: "self-signed", certPath, keyPath, created: true, warnings: [] };
}

function readSelfSigned(certPath: string, keyPath: string, now: Date): { cert: string; key: string; fingerprint: string } | undefined {
  try {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    const leaf = new X509Certificate(cert);
    if (Date.parse(leaf.validTo) - now.getTime() < RENEW_BEFORE_MS) return undefined;
    if (!leaf.checkPrivateKey(createPrivateKey(key))) return undefined;
    // Tau wrote it 0o600; a copy restored with looser bits is tightened again.
    chmodSync(keyPath, 0o600);
    return { cert, key, fingerprint: leaf.fingerprint256 };
  } catch {
    return undefined;
  }
}

/** Temp file and rename, so a crash never leaves half a key that later fails to parse. */
function writePrivate(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Names a browser checks; a pinning client ignores them. */
function subjectNames(bindHost: string | undefined): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames = new Set(["localhost"]);
  const ipAddresses = new Set(["127.0.0.1", "::1"]);
  const machine = hostname();
  if (/^[A-Za-z0-9.-]+$/u.test(machine)) dnsNames.add(machine.toLowerCase());
  const bare = bindHost?.replace(/^\[|\]$/gu, "");
  if (bare && bare !== "0.0.0.0" && bare !== "::") {
    if (isIP(bare)) ipAddresses.add(bare);
    else if (/^[A-Za-z0-9.-]+$/u.test(bare)) dnsNames.add(bare.toLowerCase());
  }
  return { dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] };
}

function parseCertificate(pem: string, path: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch (error: unknown) {
    throw new Error(`${path} holds no PEM certificate: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * A fingerprint as a user may type it — `sha256:` or `SHA256/` prefix, colons
 * or none, either case — in the `AB:CD:…` form Node and browsers print, or
 * undefined when it is not 32 bytes of hex.
 */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.trim().replace(/^sha-?256[:/=\s]*/iu, "").replace(/[\s:]/gu, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/u.test(hex)) return undefined;
  return hex.match(/.{2}/gu)!.join(":");
}

export function fingerprintsMatch(left: string, right: string): boolean {
  const a = normalizeFingerprint(left);
  return a !== undefined && a === normalizeFingerprint(right);
}

/** The pinnable fingerprint of a PEM certificate (the first, when it is a chain). */
export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}
