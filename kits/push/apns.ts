import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

export const APNS_ORIGINS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

/** A development build of the app gets sandbox tokens, a TestFlight or App Store build production ones. */
export type ApnsEnvironment = keyof typeof APNS_ORIGINS;

export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  /** The `.p8` file's text. */
  key: string;
}

export type SendOutcome =
  | { ok: true }
  /** `gone`: the token will never work again; forget the device's registration. */
  | { ok: false; gone: boolean; status: number; reason: string };

export interface ApnsRequest {
  token: string;
  /** The app's bundle identifier. */
  topic: string;
  payload: unknown;
  pushType?: "alert" | "liveactivity";
  expiration?: number;
  /** Replaces an earlier notification with the same id; at most 64 bytes. */
  collapseId?: string;
}

/** Apple takes a provider token for an hour and refuses a new one more often than every 20 minutes. */
const JWT_LIFETIME_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const KEY_ID = /^[A-Z0-9]{10}$/u;
const TEAM_ID = /^[A-Z0-9]{10}$/u;
const GONE = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

const base64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/** Reads and checks a `.p8` key; the error never repeats the text it was given. */
export function readApnsKey(credentials: ApnsCredentials): KeyObject {
  if (!KEY_ID.test(credentials.keyId)) throw new Error("The Key ID is the 10 letters and digits Apple shows beside the key.");
  if (!TEAM_ID.test(credentials.teamId)) throw new Error("The Team ID is the 10 letters and digits in your Apple Developer membership.");
  let key: KeyObject;
  try {
    key = createPrivateKey(credentials.key.trim());
  } catch {
    throw new Error("That is not a .p8 key: its text did not read as a private key.");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("An APNs key is an EC P-256 key (.p8); this is another kind of key.");
  }
  return key;
}

/** The provider token: ES256 over `{ alg, kid }.{ iss, iat }`. */
export function apnsProviderToken(credentials: Pick<ApnsCredentials, "keyId" | "teamId">, key: KeyObject, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: issuedAtSeconds }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${base64url(signature)}`;
}

export interface ApnsClientOptions {
  credentials: ApnsCredentials;
  /** Where to send for an environment; a test points both at a fake. */
  origin?(environment: ApnsEnvironment): string;
  now?(): number;
}

/**
 * Sends to Apple's push service over HTTP/2 with a token-based provider key,
 * one connection per origin, kept open between pushes as Apple asks.
 */
export class ApnsClient {
  private readonly key: KeyObject;
  private readonly now: () => number;
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private providerToken: { value: string; at: number } | undefined;

  constructor(private readonly options: ApnsClientOptions) {
    this.key = readApnsKey(options.credentials);
    this.now = options.now ?? Date.now;
  }

  async send(request: ApnsRequest, environment: ApnsEnvironment): Promise<SendOutcome> {
    const first = await this.post(request, environment);
    if (first.ok || (first.reason !== "ExpiredProviderToken" && first.reason !== "InvalidProviderToken")) return first;
    // Apple may have seen an old token; one more try with a fresh one.
    this.providerToken = undefined;
    return this.post(request, environment);
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private token(): string {
    const now = this.now();
    if (!this.providerToken || now - this.providerToken.at >= JWT_LIFETIME_MS) {
      this.providerToken = { value: apnsProviderToken(this.options.credentials, this.key, Math.floor(now / 1000)), at: now };
    }
    return this.providerToken.value;
  }

  private async post(request: ApnsRequest, environment: ApnsEnvironment): Promise<SendOutcome> {
    const origin = this.options.origin?.(environment) ?? APNS_ORIGINS[environment];
    const headers: Record<string, string> = {
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(request.token)}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": request.topic,
      "apns-push-type": request.pushType ?? "alert",
      "apns-priority": "10",
      // A day later the news is stale; Apple drops it rather than deliver it then.
      "apns-expiration": String(request.expiration ?? Math.floor(this.now() / 1000) + 24 * 60 * 60),
      "content-type": "application/json",
      ...(request.collapseId ? { "apns-collapse-id": request.collapseId } : {}),
    };
    let response: { status: number; body: string };
    try {
      response = await this.request(origin, headers, JSON.stringify(request.payload));
    } catch (error) {
      return { ok: false, gone: false, status: 0, reason: error instanceof Error ? error.message : String(error) };
    }
    if (response.status === 200) return { ok: true };
    let reason = `HTTP ${response.status}`;
    try { reason = (JSON.parse(response.body) as { reason?: string }).reason ?? reason; } catch { /* not JSON */ }
    return { ok: false, gone: response.status === 410 || GONE.has(reason), status: response.status, reason };
  }

  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    const forget = () => { if (this.sessions.get(origin) === session) this.sessions.delete(origin); };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    session.setTimeout(IDLE_CLOSE_MS, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private request(origin: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.session(origin).request(headers);
      let status = 0;
      let data = "";
      stream.setEncoding("utf8");
      stream.on("response", (answer) => { status = Number(answer[constants.HTTP2_HEADER_STATUS]); });
      stream.on("data", (chunk: string) => { data += chunk; });
      stream.on("end", () => resolve({ status, body: data }));
      stream.on("error", reject);
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error("Apple's push service did not answer in time."));
      });
      stream.end(body);
    });
  }
}
