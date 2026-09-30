import { openHandle, sealHandle, validToken, type Keyring, type RelayPlatform } from "./handle.js";
import { RateLimiter } from "./limits.js";

/** The sealed text a host hands over; the relay checks its size and alphabet, never its content. */
const PAYLOAD = /^[A-Za-z0-9._-]{1,3072}$/u;
/** APNs takes a collapse id of at most 64 bytes. */
const COLLAPSE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_BODY_BYTES = 8 * 1024;

export interface RelayRequest {
  method: string;
  path: string;
  body: Buffer | string | undefined;
  /** The caller's address, for the register limit; hashed, never logged. */
  ip?: string;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OutboundMessage {
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

/** Event names and codes only: never a token, handle, payload or address. */
export type RelayLog = (event: string, fields: Record<string, string | number | boolean>) => void;

export interface RelayOptions {
  keyring: Keyring;
  senders: Senders;
  log?: RelayLog;
  now?(): number;
  /** Per handle: a burst of this many sends, then one per `sendRefillMs`. */
  sendBurst?: number;
  sendRefillMs?: number;
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
  const registers = new RateLimiter({ capacity: options.registerBurst ?? 10, refillMs: options.registerRefillMs ?? 60_000, now });
  const limited = (wait: number, headers: Record<string, string> = {}) => reply(429, { error: "rate-limited" }, { ...headers, "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) });

  const register = (body: Record<string, unknown>, ip: string | undefined): RelayResponse => {
    const wait = registers.take(`register:${ip ?? "unknown"}`);
    if (wait > 0) {
      log("register.limited", {});
      return limited(wait, CORS_HEADERS);
    }
    if (!validToken(body.platform, body.token)) return reply(400, { error: "bad-request", detail: "register takes { platform: ios | android, token }." }, CORS_HEADERS);
    log("register", { platform: body.platform as string });
    return reply(200, { handle: sealHandle(options.keyring, { platform: body.platform as RelayPlatform, token: body.token as string }) }, CORS_HEADERS);
  };

  const send = async (body: Record<string, unknown>): Promise<RelayResponse> => {
    const { handle, payload, collapseId } = body;
    if (typeof handle !== "string" || typeof payload !== "string" || !PAYLOAD.test(payload) || (collapseId !== undefined && (typeof collapseId !== "string" || !COLLAPSE_ID.test(collapseId)))) {
      return reply(400, { error: "bad-request", detail: "send takes { handle, payload (at most 3072 characters of base64url and dots), collapseId? }." });
    }
    const wait = sends.take(`send:${handle}`);
    if (wait > 0) {
      log("send.limited", {});
      return limited(wait);
    }
    const registration = openHandle(options.keyring, handle);
    if (!registration) {
      log("send.unknown-handle", {});
      return reply(410, { error: "gone", reason: "unknown-handle" });
    }
    const sender = options.senders[registration.platform];
    if (!sender) {
      log("send.unconfigured", { platform: registration.platform });
      return reply(503, { error: "unavailable", reason: `${registration.platform === "ios" ? "apns" : "fcm"}-not-configured` });
    }
    let delivery: Delivery;
    try {
      delivery = await sender(registration.token, { sealed: payload, ...(typeof collapseId === "string" ? { collapseId } : {}) });
    } catch {
      delivery = { ok: false, gone: false, reason: "sender-failed" };
    }
    log("send", { platform: registration.platform, ok: delivery.ok, ...(delivery.ok ? {} : { reason: delivery.reason, gone: delivery.gone }) });
    if (delivery.ok) return reply(200, { ok: true });
    return delivery.gone ? reply(410, { error: "gone", reason: delivery.reason }) : reply(502, { error: "upstream", reason: delivery.reason });
  };

  return async (request) => {
    const path = request.path.replace(/\/+$/u, "") || "/";
    const route = path === "/register" ? "register" : path === "/send" ? "send" : undefined;
    if (!route) return reply(404, { error: "not-found" });
    if (route === "register" && request.method === "OPTIONS") return { status: 204, headers: { ...CORS_HEADERS }, body: "" };
    const cors = route === "register" ? CORS_HEADERS : {};
    if (request.method !== "POST") return reply(405, { error: "method-not-allowed" }, { ...cors, allow: "POST" });
    const body = readJson(request.body);
    if (body === "too-large") return reply(413, { error: "too-large" }, cors);
    if (!body) return reply(400, { error: "bad-request", detail: "The body is not a JSON object." }, cors);
    return route === "register" ? register(body, request.ip) : send(body);
  };
}
