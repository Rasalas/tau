import { canonicalFingerprint, type DeviceAccess } from "./connections.js";

/**
 * Pairing over the host socket (ADR 0024): a device asks, the owner allows it
 * on the host, and both screens show the same six digits first. A device that
 * pinned the host's certificate binds the digits to it, so a relay that
 * presents a certificate of its own cannot make the two screens agree.
 */

/** How long a request waits for the owner before it expires. */
export const PAIRING_REQUEST_LIFETIME_MS = 2 * 60_000;

/** A device's request. `code` comes from a pairing link; without one the host still asks its owner. */
export interface HostPairRequest {
  code?: string;
  /** What the device calls itself ("Alex's iPhone"); shown to the owner, never trusted. */
  name?: string;
  /**
   * SHA-256 (hex) of a random nonce the device reveals once the host sent its
   * own. With it the digits depend on both nonces and what the device pinned;
   * without it the host picks the digits.
   */
  commitment?: string;
  /** `key`: the digits are bound to the listener's public key. Absent: to its certificate, as older devices bind them. */
  binding?: "key";
}

export type PairRefusal = "unknown-code" | "busy" | "rate-limited" | "invalid";

export type HostPairReply =
  /** Answer with `pair-reveal`; only a request with a commitment gets this. */
  | { state: "challenge"; requestId: string; hostNonce: string }
  /** The owner sees the request now; show `verification` until the host decides. */
  | { state: "waiting"; requestId: string; verification: string; expiresAt: string }
  /** Say hello with `token`; the same socket may be used for it. */
  | { state: "approved"; token: string; clientId: string; access: DeviceAccess }
  | { state: "denied" }
  | { state: "expired" }
  /** Refused before anyone was asked. An expired, spent or invented code is one answer: `unknown-code`. */
  | { state: "refused"; reason: PairRefusal; retryAfterMs?: number };

const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;

export const isPairingNonce = (value: unknown): value is string => typeof value === "string" && NONCE.test(value);
export const isPairingCommitment = (value: unknown): value is string => typeof value === "string" && HEX_64.test(value);

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  // Browsers offer it only in a secure context: https, or a loopback address.
  if (!subtle) throw new Error("This page cannot compute a pairing code: it needs https or a loopback address.");
  return subtle;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await subtleCrypto().digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** 32 random bytes, base64url. */
export function randomPairingNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function pairingCommitment(deviceNonce: string): Promise<string> {
  return hex(await sha256(deviceNonce));
}

/**
 * Six digits from what the device pinned and both nonces. The host computes
 * them with its own key (or certificate); a device that reached it through a
 * relay with another key computes different ones. With `publicKey` given,
 * even empty, the digits are bound to the key; else to the certificate
 * `fingerprint`. Either is empty on a plaintext loopback socket.
 */
export async function pairingVerificationCode(input: { fingerprint?: string; publicKey?: string; deviceNonce: string; hostNonce: string }): Promise<string> {
  const key = input.publicKey !== undefined;
  const pinned = key ? input.publicKey : input.fingerprint;
  const bound = pinned ? canonicalFingerprint(pinned) ?? "" : "";
  const digest = await sha256(`${key ? "tau-pair-v2" : "tau-pair-v1"}\n${bound}\n${input.deviceNonce}\n${input.hostNonce}`);
  const value = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}

/** `482 913`: easier to compare across two screens. */
export function formatVerification(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
