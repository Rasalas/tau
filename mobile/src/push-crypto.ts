import { SEALED_PUSH_VERSION, sealedPushAad, type SealedPushContent } from "../../kits/push/protocol";

const KEY_BYTES = 32;
const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const SEALED = /^(\d{1,3})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,})$/u;

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A key for what a host's pushes say: 32 random bytes, and a random id that names it in each push. */
export function newPushKey(): { keyId: string; key: string } {
  return {
    keyId: toBase64url(crypto.getRandomValues(new Uint8Array(KEY_ID_BYTES))),
    key: toBase64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES))),
  };
}

/**
 * Opens a sealed push (kits/push/protocol.ts): AES-256-GCM, the 96-bit nonce
 * first, the key id bound as associated data. Undefined for anything that
 * does not open or does not read, never an error.
 */
export async function openSealedPush(sealed: unknown, keyFor: (keyId: string) => Promise<string | undefined>): Promise<SealedPushContent | undefined> {
  const match = typeof sealed === "string" ? SEALED.exec(sealed) : null;
  if (!match || Number(match[1]) !== SEALED_PUSH_VERSION) return undefined;
  const keyId = match[2]!;
  try {
    const raw = await keyFor(keyId);
    if (!raw) return undefined;
    const key = await crypto.subtle.importKey("raw", fromBase64url(raw), "AES-GCM", false, ["decrypt"]);
    const bytes = fromBase64url(match[3]!);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, NONCE_BYTES), additionalData: new TextEncoder().encode(sealedPushAad(keyId)), tagLength: 128 },
      key,
      bytes.slice(NONCE_BYTES),
    );
    const value = JSON.parse(new TextDecoder().decode(plain)) as Partial<SealedPushContent>;
    if (typeof value.title !== "string" || typeof value.body !== "string") return undefined;
    return {
      title: value.title,
      body: value.body,
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
      ...(typeof value.tag === "string" ? { tag: value.tag } : {}),
    };
  } catch {
    return undefined;
  }
}
