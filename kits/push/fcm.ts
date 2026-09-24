import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { SendOutcome } from "./apns.js";

export const FCM_ORIGIN = "https://fcm.googleapis.com";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 15_000;

/** The fields of a Firebase service account file this client uses. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https, or plain http to this machine alone (a test's fake). */
function safeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

/** Reads a service account file's text and checks its key; errors never repeat the file. */
export function readServiceAccount(text: string): { account: FcmServiceAccount; key: KeyObject } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("That is not a service account file: it is not JSON.");
  }
  if (!raw || typeof raw !== "object" || raw.type !== "service_account") throw new Error("That JSON is not a service account file (its type is not service_account).");
  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = raw;
  const tokenUri = typeof raw.token_uri === "string" && raw.token_uri ? raw.token_uri : GOOGLE_TOKEN_URI;
  if (typeof projectId !== "string" || !projectId) throw new Error("The service account file names no project_id.");
  if (typeof clientEmail !== "string" || !clientEmail.includes("@")) throw new Error("The service account file names no client_email.");
  if (typeof privateKey !== "string") throw new Error("The service account file has no private_key.");
  if (!safeEndpoint(tokenUri)) throw new Error("The service account's token_uri is not an https address.");
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new Error("The service account's private_key did not read as a key.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("A service account's private_key is an RSA key; this is another kind.");
  return { account: { projectId, clientEmail, privateKey, tokenUri }, key };
}

/** The assertion Google trades for an access token: RS256 over the service account's claims. */
export function serviceAccountAssertion(account: Pick<FcmServiceAccount, "clientEmail" | "tokenUri">, key: KeyObject, issuedAtSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.clientEmail, scope: SCOPE, aud: account.tokenUri, iat: issuedAtSeconds, exp: issuedAtSeconds + 3600 })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), key).toString("base64url")}`;
}

export interface FcmClientOptions {
  serviceAccount: string;
  /** A test's fake instead of fcm.googleapis.com. */
  origin?: string;
  fetch?: typeof fetch;
  now?(): number;
}

/** A message for FCM's HTTP v1 API, less the token. */
export interface FcmMessage {
  notification: { title: string; body: string };
  data?: Record<string, string>;
  android?: Record<string, unknown>;
}

/**
 * Sends through Firebase Cloud Messaging's HTTP v1 API with the user's own
 * service account: an OAuth access token from the signed assertion, kept
 * until shortly before it runs out.
 */
export class FcmClient {
  readonly account: FcmServiceAccount;
  private readonly key: KeyObject;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly origin: string;
  private access: { token: string; until: number } | undefined;

  constructor(options: FcmClientOptions) {
    ({ account: this.account, key: this.key } = readServiceAccount(options.serviceAccount));
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.origin = options.origin ?? FCM_ORIGIN;
  }

  async send(token: string, message: FcmMessage): Promise<SendOutcome> {
    const first = await this.post(token, message);
    if (first.ok || first.status !== 401) return first;
    this.access = undefined;
    return this.post(token, message);
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.access && now < this.access.until) return this.access.token;
    const assertion = serviceAccountAssertion(this.account, this.key, Math.floor(now / 1000));
    const response = await this.fetch(this.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new Error(`Google refused the service account: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}.`);
    }
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.access = { token: body.access_token, until: now + Math.max(60, seconds - 60) * 1000 };
    return this.access.token;
  }

  private async post(token: string, message: FcmMessage): Promise<SendOutcome> {
    let response: Response;
    try {
      const access = await this.accessToken();
      response = await this.fetch(`${this.origin}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token, ...message } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, gone: false, status: 0, reason: error instanceof Error ? error.message : String(error) };
    }
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => ({})) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    const code = body.error?.details?.find((detail) => detail.errorCode)?.errorCode ?? body.error?.status ?? `HTTP ${response.status}`;
    const gone = code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /registration token/iu.test(body.error?.message ?? ""));
    return { ok: false, gone, status: response.status, reason: code };
  }
}
