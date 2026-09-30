import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type RelayPlatform = "ios" | "android";

/** What a handle seals: where to deliver, nothing else. */
export interface Registration {
  platform: RelayPlatform;
  token: string;
}

/** The handle's layout; a new layout gets a new version, a new key only a new key id. */
export const HANDLE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 2;
const KEY_BYTES = 32;
const AAD_LABEL = "tau-relay-handle";
const HANDLE_TEXT = /^[A-Za-z0-9_-]{40,6000}$/u;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/iu;
const FCM_TOKEN = /^[\w:.-]{20,4096}$/u;

export function validToken(platform: unknown, token: unknown): platform is RelayPlatform {
  if (typeof token !== "string") return false;
  if (platform === "ios") return APNS_TOKEN.test(token);
  if (platform === "android") return FCM_TOKEN.test(token);
  return false;
}

export interface Keyring {
  /** The id new handles are sealed with. */
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

/**
 * `RELAY_HANDLE_KEYS`: comma-separated `<id>:<32 bytes as base64>` entries,
 * ids 1–255. The first seals; every one listed still opens.
 */
export function parseKeyring(text: string): Keyring {
  const keys = new Map<number, Buffer>();
  let current: number | undefined;
  const entries = text.split(",").map((part) => part.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    const match = /^(\d{1,3}):([A-Za-z0-9+/_-]+={0,2})$/u.exec(entry);
    const id = match ? Number(match[1]) : Number.NaN;
    const key = match ? Buffer.from(match[2]!, "base64") : undefined;
    if (!key || !(id >= 1 && id <= 255) || key.length !== KEY_BYTES) {
      throw new Error(`RELAY_HANDLE_KEYS entry ${index + 1} is not "<1-255>:<32 bytes as base64>".`);
    }
    if (keys.has(id)) throw new Error(`RELAY_HANDLE_KEYS names key ${id} twice.`);
    keys.set(id, key);
    current ??= id;
  });
  if (current === undefined) throw new Error("RELAY_HANDLE_KEYS holds no key.");
  return { current, keys };
}

const additionalData = (version: number, keyId: number) => Buffer.concat([Buffer.from(AAD_LABEL), Buffer.from([version, keyId])]);

/** `version ‖ keyId ‖ nonce ‖ AES-256-GCM(JSON) ‖ tag`, base64url. */
export function sealHandle(keyring: Keyring, registration: Registration): string {
  const keyId = keyring.current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.keys.get(keyId)!, nonce);
  cipher.setAAD(additionalData(HANDLE_VERSION, keyId));
  const plain = Buffer.from(JSON.stringify({ p: registration.platform, t: registration.token }));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([HANDLE_VERSION, keyId]), nonce, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** The registration a handle seals, or undefined for one this relay did not make or can no longer open. */
export function openHandle(keyring: Keyring, handle: unknown): Registration | undefined {
  if (typeof handle !== "string" || !HANDLE_TEXT.test(handle)) return undefined;
  const bytes = Buffer.from(handle, "base64url");
  if (bytes.length <= HEADER_BYTES + NONCE_BYTES + TAG_BYTES || bytes[0] !== HANDLE_VERSION) return undefined;
  const keyId = bytes[1]!;
  const key = keyring.keys.get(keyId);
  if (!key) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES));
    decipher.setAAD(additionalData(HANDLE_VERSION, keyId));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
    const value = JSON.parse(plain.toString("utf8")) as { p?: unknown; t?: unknown };
    return validToken(value.p, value.t) ? { platform: value.p, token: value.t as string } : undefined;
  } catch {
    return undefined;
  }
}
