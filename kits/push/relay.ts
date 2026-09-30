import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import type { SendOutcome } from "./apns.js";
import { SEALED_PUSH_VERSION, sealedPushAad, type PushRelayRegistration, type SealedPushContent } from "./protocol.js";

const NONCE_BYTES = 12;
const REQUEST_TIMEOUT_MS = 15_000;

type PushKey = Pick<PushRelayRegistration, "keyId" | "key">;

/** Encrypts what a push says for the phone alone (protocol.ts, `SEALED_PUSH_VERSION`). */
export function sealPush(key: PushKey, content: SealedPushContent): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key, "base64url"), nonce);
  cipher.setAAD(Buffer.from(sealedPushAad(key.keyId)));
  const sealed = Buffer.concat([nonce, cipher.update(JSON.stringify(content), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${SEALED_PUSH_VERSION}.${key.keyId}.${sealed.toString("base64url")}`;
}

/** A thread's collapse id the relay cannot trace back to the thread: an HMAC under the phone's key. */
export function sealedCollapseId(key: PushKey, threadId: string): string {
  return createHmac("sha256", Buffer.from(key.key, "base64url")).update(`collapse:${threadId}`).digest("base64url").slice(0, 22);
}

export interface RelaySend {
  handle: string;
  payload: string;
  collapseId?: string;
}

/** `POST <relay>/send`; a 410 means the phone's token or handle is gone for good. */
export async function sendThroughRelay(url: string, request: RelaySend, fetcher: typeof fetch = fetch): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetcher(`${url}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, gone: false, status: 0, reason: `Tau's relay did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({})) as { error?: unknown; reason?: unknown };
  const code = typeof body.reason === "string" ? body.reason : typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  return { ok: false, gone: response.status === 410, status: response.status, reason: `relay: ${code}` };
}
