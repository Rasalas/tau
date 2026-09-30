import { openHandle, sealHandle, validToken, type Keyring, type RelayPlatform } from "./handle.js";
import { RateLimiter } from "./limits.js";

/** The sealed text a host hands over; the relay checks its size and alphabet, never its content. */
const PAYLOAD = /^[A-Za-z0-9._-]{1,3072}$/u;
/** APNs takes a collapse id of at most 64 bytes. */
const COLLAPSE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** Room for the longest handle, payload and collapse id with their JSON around them (relay.test.ts). */
export const MAX_BODY_BYTES = 10 * 1024;
/** The relay answers a handle older than this with 410; the app renews its handles at half this age. */
export const HANDLE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export type RelayHeaders = Record<string, string | string[] | undefined>;

export interface RelayRequest {
  method: string;
  path: string;
  body: Buffer | string | undefined;
  /** For `content-length` and `x-forwarded-for`, lower-case names as Node gives them. */
  headers?: RelayHeaders;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RelayActivity { event: "update" | "end"; timestamp: number; expiresAt: number }
export interface OutboundMessage {
  activity?: RelayActivity;
  sealed: string;
  collapseId?: string;
}

export type Delivery =
  | { ok: true }
  /** `gone`: the token will never work again; the host drops the handle. */
  | { ok: false; gone: boolean; reason: string };

export type Sender = (token: string, message: OutboundMessage) => Promise<Delivery>;

/** A sender per platform; one left out answers 503 (APNs before its key is set up). */
export type Senders = Partial<Record<RelayPlatform, Sender>>;

/** Warnings and errors only, event names and codes: never a token, handle, payload or address. */
export type RelayLog = (level: "warn" | "error", event: string, fields: Record<string, string | number | boolean>) => void;

export interface RelayOptions {
  keyring: Keyring;
  senders: Senders;
  log?: RelayLog;
  now?(): number;
  /** Per handle: a burst of this many sends, then one per `sendRefillMs`. */
  sendBurst?: number;
  sendRefillMs?: number;
  /** Per phone, over all its handles: a burst of this many sends, then one per `tokenRefillMs`. */
  tokenBurst?: number;
  tokenRefillMs?: number;
  /** Per address: a burst of this many registrations, then one per `registerRefillMs`. */
  registerBurst?: number;
  registerRefillMs?: number;
}

const BASE_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
// The app's web view calls /register from its own origin (capacitor://localhost, https://localhost).
const CORS_HEADERS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };

function reply(status: number, value: unknown, headers: Record<string, string> = {}): RelayResponse {
  return { status, headers: { ...BASE_HEADERS, ...headers }, body: JSON.stringify(value) };
}

const header = (headers: RelayHeaders | undefined, name: string): string | undefined => {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(",") : value;
};

/**
 * The caller's address: the last `X-Forwarded-For` entry, the one Google's
 * front end appends. Entries before it are the caller's to write.
 */
export function callerAddress(headers: RelayHeaders | undefined): string | undefined {
  const entries = header(headers, "x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries?.at(-1);
}

/** A declared length over the limit; the body is checked again once read. */
function declaredTooLarge(headers: RelayHeaders | undefined): boolean {
  const length = Number(header(headers, "content-length"));
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

function readJson(body: Buffer | string | undefined): Record<string, unknown> | "too-large" | undefined {
  const text = typeof body === "string" ? body : body?.toString("utf8") ?? "";
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return "too-large";
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The relay, apart from Firebase: `POST /register` seals a phone's push token
 * into a handle, `POST /send` opens one and hands the host's sealed payload to
 * FCM or APNs. Stateless but for the rate limits in memory.
 */
export function createRelay(options: RelayOptions): (request: RelayRequest) => Promise<RelayResponse> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const sends = new RateLimiter({ capacity: options.sendBurst ?? 30, refillMs: options.sendRefillMs ?? 6_000, now });
  // Minting more handles for one token does not buy more sends.
  const tokenSends = new RateLimiter({ capacity: options.tokenBurst ?? 60, refillMs: options.tokenRefillMs ?? 3_000, now });
  const registers = new RateLimiter({ capacity: options.registerBurst ?? 10, refillMs: options.registerRefillMs ?? 60_000, now });
  const limited = (wait: number, headers: Record<string, string> = {}) => reply(429, { error: "rate-limited" }, { ...headers, "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) });

  const register = (body: Record<string, unknown>, address: string | undefined): RelayResponse => {
    const wait = registers.take(`register:${address ?? "unknown"}`);
    if (wait > 0) return limited(wait, CORS_HEADERS);
    if (!validToken(body.platform, body.token)) return reply(400, { error: "bad-request", detail: "register takes { platform: ios | android, token }." }, CORS_HEADERS);
    if (body.purpose !== undefined && (body.purpose !== "activity" || body.platform !== "ios")) return reply(400, { error: "bad-request" }, CORS_HEADERS);
    const purpose = body.purpose === "activity" ? "activity" as const : undefined;
    return reply(200, { handle: sealHandle(options.keyring, { platform: body.platform as RelayPlatform, token: body.token as string, ...(purpose ? { purpose } : {}) }, now()), ...(purpose ? { purpose } : {}) }, CORS_HEADERS);
  };

  const send = async (body: Record<string, unknown>): Promise<RelayResponse> => {
    const { handle, payload, collapseId } = body;
    if (typeof handle !== "string" || typeof payload !== "string" || !PAYLOAD.test(payload) || (collapseId !== undefined && (typeof collapseId !== "string" || !COLLAPSE_ID.test(collapseId)))) {
      return reply(400, { error: "bad-request", detail: "send takes { handle, payload (at most 3072 characters of base64url and dots), collapseId? }." });
    }
    const wait = sends.take(`send:${handle}`);
    if (wait > 0) return limited(wait);
    const registration = openHandle(options.keyring, handle);
    if (!registration) return reply(410, { error: "gone", reason: "unknown-handle" });
    if (now() - registration.issuedAt > HANDLE_MAX_AGE_MS) return reply(410, { error: "gone", reason: "expired-handle" });
    const activity = body.activity as Partial<RelayActivity> | undefined;
    if (registration.purpose === "activity") {
      const at = Math.floor(now() / 1000);
      if (!activity || (activity.event !== "update" && activity.event !== "end") || !Number.isSafeInteger(activity.timestamp) || !Number.isSafeInteger(activity.expiresAt)
          || activity.timestamp! < at - 300 || activity.timestamp! > at + 60 || activity.expiresAt! < at || activity.expiresAt! > at + 8 * 60 * 60) return reply(400, { error: "bad-activity" });
    } else if (activity !== undefined) return reply(400, { error: "wrong-purpose" });
    const tokenWait = tokenSends.take(`token:${registration.token}`);
    if (tokenWait > 0) return limited(tokenWait);
    const sender = options.senders[registration.platform];
    if (!sender) {
      log("warn", "send.unconfigured", { platform: registration.platform });
      return reply(503, { error: "unavailable", reason: `${registration.platform === "ios" ? "apns" : "fcm"}-not-configured` });
    }
    let delivery: Delivery;
    try {
      delivery = await sender(registration.token, { sealed: payload, ...(activity ? { activity: activity as RelayActivity } : {}), ...(typeof collapseId === "string" ? { collapseId } : {}) });
    } catch {
      delivery = { ok: false, gone: false, reason: "sender-failed" };
    }
    if (delivery.ok) return reply(200, { ok: true });
    if (delivery.gone) return reply(410, { error: "gone", reason: delivery.reason });
    log(delivery.reason === "sender-failed" ? "error" : "warn", "send.upstream", { platform: registration.platform, reason: delivery.reason });
    return reply(502, { error: "upstream", reason: delivery.reason });
  };

  return async (request) => {
    if (declaredTooLarge(request.headers)) return reply(413, { error: "too-large" });
    const path = request.path.replace(/\/+$/u, "") || "/";
    const route = path === "/register" ? "register" : path === "/send" ? "send" : undefined;
    if (!route) return reply(404, { error: "not-found" });
    if (route === "register" && request.method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
    const cors = route === "register" ? CORS_HEADERS : {};
    if (request.method !== "POST") return reply(405, { error: "method-not-allowed" }, { ...cors, allow: "POST" });
    const body = readJson(request.body);
    if (body === "too-large") return reply(413, { error: "too-large" }, cors);
    if (!body) return reply(400, { error: "bad-request", detail: "The body is not a JSON object." }, cors);
    return route === "register" ? register(body, callerAddress(request.headers)) : send(body);
  };
}
