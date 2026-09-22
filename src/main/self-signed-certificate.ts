import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/**
 * A minimal X.509 v3 builder for one purpose: a host's own self-signed
 * certificate, which clients pin by fingerprint instead of trusting a CA.
 * ECDSA P-256 with SHA-256; no dependency beyond `node:crypto`.
 */
export interface SelfSignedCertificateOptions {
  commonName: string;
  dnsNames: readonly string[];
  ipAddresses: readonly string[];
  /** How long it is valid; Apple platforms refuse a server certificate beyond 825 days. */
  days: number;
  now?: Date;
}

export interface SelfSignedCertificate {
  cert: string;
  key: string;
}

export function createSelfSignedCertificate(options: SelfSignedCertificateOptions): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = options.now ?? new Date();
  // A minute of slack for a client whose clock is a little behind.
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + options.days * 86_400_000);
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(options.commonName))));
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const serial = randomBytes(16);
  // Positive and without a leading zero byte of its own.
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(
      extension("2.5.29.19", true, sequence()),
      // digitalSignature only: bit 0 set, seven unused bits.
      extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
      extension("2.5.29.17", false, sequence(
        ...options.dnsNames.map((dns) => tlv(0x82, Buffer.from(dns, "ascii"))),
        ...options.ipAddresses.map((ip) => tlv(0x87, ipBytes(ip))),
      )),
    )),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(tbs, algorithm, bitString(signature));
  return {
    cert: pem("CERTIFICATE", der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

function sequence(...items: Buffer[]): Buffer { return tlv(0x30, Buffer.concat(items)); }
function set(...items: Buffer[]): Buffer { return tlv(0x31, Buffer.concat(items)); }
function explicit(index: number, content: Buffer): Buffer { return tlv(0xa0 | index, content); }
function utf8(text: string): Buffer { return tlv(0x0c, Buffer.from(text, "utf8")); }
function bitString(bytes: Buffer): Buffer { return tlv(0x03, Buffer.concat([Buffer.from([0]), bytes])); }

function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

/** UTCTime until 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  const year = date.getUTCFullYear();
  return year < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii")) : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function ipBytes(ip: string): Buffer {
  if (isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  if (!isIPv6(ip)) throw new Error(`Not an IP address: ${ip}`);
  const [head = "", tail = ""] = ip.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = ip.includes("::") ? groups(tail) : [];
  const middle = new Array<string>(8 - left.length - right.length).fill("0");
  const bytes = Buffer.alloc(16);
  [...left, ...middle, ...right].forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/gu)!.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
