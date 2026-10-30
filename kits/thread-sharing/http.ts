import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostHttpRoute } from "tau/host-extension";
import { GuestError, GuestShares } from "./store.js";
import { GUEST_PATH, type GuestImage, type GuestView } from "./protocol.js";
import { guestHtml, guestScript } from "./page.js";
import { guestTranscript } from "./projection.js";

const HEADERS = {
  "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "x-frame-options": "DENY", "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
};
function reply(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
async function body(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new GuestError(415, "json_required");
  if (Number(request.headers["content-length"]) > limit) throw new GuestError(413, "too_large");
  const chunks: Buffer[] = [];
  let length = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; request.destroy(); }, 10_000);
  timeout.unref();
  try {
    for await (const chunk of request) {
      length += Buffer.byteLength(chunk);
      if (length > limit) throw new GuestError(413, "too_large");
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GuestError) throw error;
    throw new GuestError(timedOut ? 408 : 400, "invalid_body");
  } finally { clearTimeout(timeout); }
}
function images(value: unknown): GuestImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new GuestError(400, "invalid_images");
  let bytes = 0;
  return value.map((image: unknown) => {
    if (!image || typeof image !== "object") throw new GuestError(400, "invalid_images");
    const { mimeType, data } = image as Record<string, unknown>;
    if (!["image/png", "image/jpeg", "image/webp"].includes(String(mimeType)) || typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) || data.length % 4) throw new GuestError(400, "invalid_images");
    const decoded = Buffer.from(data, "base64");
    bytes += decoded.length;
    if (bytes > 10 * 1024 * 1024) throw new GuestError(413, "too_large");
    // No SVG, HTML, file path, data URL or remote URL can become an attachment.
    const png = decoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = decoded[0] === 255 && decoded[1] === 216 && decoded[2] === 255;
    const webp = decoded.toString("ascii", 0, 4) === "RIFF" && decoded.toString("ascii", 8, 12) === "WEBP";
    if (!((mimeType === "image/png" && png) || (mimeType === "image/jpeg" && jpeg) || (mimeType === "image/webp" && webp))) throw new GuestError(400, "invalid_images");
    return { mimeType, data } as GuestImage;
  });
}
export interface GuestRouteOptions {
  store: GuestShares;
  origins(): readonly string[];
  eligible(threadId: string): Promise<boolean>;
  view(threadId: string, grantId: string): Promise<Omit<GuestView, "mode" | "expiresAt" | "suggestions">>;
  now?: () => number;
}
/** No workbench transport, session id, filesystem or tool route is dispatched here. */
export function guestRoute(options: GuestRouteOptions): HostHttpRoute {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { start: number; count: number }>();
  let active = 0;
  const spend = (key: string, limit: number) => {
    const time = now();
    for (const [id, bucket] of buckets) if (time - bucket.start >= 60_000) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 2048) throw new GuestError(429, "rate_limited");
      bucket = { start: time, count: 0 }; buckets.set(key, bucket);
    }
    if (++bucket.count > limit) throw new GuestError(429, "rate_limited");
  };
  return async (request, response, trust) => {
    const raw = request.url ?? "";
    if (raw.split("?")[0] !== GUEST_PATH && !raw.startsWith(GUEST_PATH + "/")) return false;
    try {
      if (raw.length > 512 || raw.includes("?") || raw.includes("#") || raw.includes("%")) throw new GuestError(400, "invalid_url");
      const paths = [GUEST_PATH, `${GUEST_PATH}/client.js`, `${GUEST_PATH}/claim`, `${GUEST_PATH}/view`, `${GUEST_PATH}/suggest`];
      if (!paths.includes(raw)) throw new GuestError(404, "not_found");
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site" || (origin && !options.origins().includes(origin))) throw new GuestError(403, "origin_denied");
      // Public traffic requires an already opted-in, browser-trusted HTTPS endpoint.
      // Tests and this machine's local window may use the loopback listener.
      if (trust !== "loopback" && options.origins().length === 0) throw new GuestError(403, "unavailable");
      const address = request.socket.remoteAddress ?? "unknown"; // Never trust X-Forwarded-For supplied by a guest.
      spend(address, 1800);
      if (active >= 16) throw new GuestError(429, "busy");
      if (raw === GUEST_PATH || raw.endsWith("/client.js")) {
        if (request.method !== "GET") throw new GuestError(405, "method_not_allowed");
        response.writeHead(200, { ...HEADERS, "content-type": raw === GUEST_PATH ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
        response.end(raw === GUEST_PATH ? guestHtml : guestScript);
        return true;
      }
      const expected = raw.endsWith("/view") ? "GET" : "POST";
      if (request.method !== expected) throw new GuestError(405, "method_not_allowed");
      if (expected === "POST" && !origin) throw new GuestError(403, "origin_required");
      const token = /^Bearer ([A-Za-z0-9_.-]{1,150})$/u.exec(request.headers.authorization ?? "")?.[1];
      if (!token) throw new GuestError(403, "ended");
      active++;
      const deadline = setTimeout(() => reply(response, 503, { error: "unavailable" }), 15_000);
      deadline.unref();
      const connected = () => { if (response.writableEnded || response.destroyed) throw new GuestError(408, "disconnected"); };
      try {
        if (raw.endsWith("/claim")) {
          spend(`${address}:claim`, 10);
          const input = await body(request, 1024);
          // The claim contains no transcript; eligibility is checked before its response.
          const browserToken = typeof input.browserToken === "string" ? input.browserToken : "";
          connected();
          await options.store.claim(token, browserToken);
          const grant = options.store.authorize(browserToken);
          if (!await options.eligible(grant.threadId)) { await options.store.revoke(grant.id); throw new GuestError(403, "ended"); }
          options.store.authorize(browserToken);
          reply(response, 200, { claimed: true });
        } else {
          const grant = options.store.authorize(token);
          spend(`grant:${grant.id}`, 90);
          if (!await options.eligible(grant.threadId)) { await options.store.revoke(grant.id); throw new GuestError(403, "ended"); }
          options.store.authorize(token);
          if (raw.endsWith("/view")) {
            const view = await options.view(grant.threadId, grant.id);
            // All async reads complete before the final authorization. Revocation wins.
            if (!await options.eligible(grant.threadId)) { await options.store.revoke(grant.id); throw new GuestError(403, "ended"); }
            options.store.authorize(token);
            options.store.touch(token);
            const suggestions = options.store.list().find((s) => s.id === grant.id)?.suggestions.map(({ id, state }) => ({ id, state })) ?? [];
            // Never spread a provider/cache object into a public response. The
            // grant, not a request field, controls output on every response.
            reply(response, 200, { title: view.title.slice(0, 200), machine: view.machine.slice(0, 200), ...guestTranscript(view.messages, { tools: view.tools, truncated: view.truncated }, grant.showToolOutput), mode: grant.mode, expiresAt: grant.expiresAt, suggestions });
          } else {
            spend(`${address}:suggest`, 6);
            const input = await body(request, 14 * 1024 * 1024 + 32_768);
            if (Object.keys(input).some((key) => !["text", "images"].includes(key))) throw new GuestError(400, "invalid_body");
            const text = typeof input.text === "string" ? input.text.trim() : "";
            const attachments = images(input.images);
            if (text.length > 8000 || (!text && attachments.length === 0)) throw new GuestError(400, "invalid_message");
            if (!await options.eligible(grant.threadId)) { await options.store.revoke(grant.id); throw new GuestError(403, "ended"); }
            connected();
            const id = options.store.suggest(token, text, attachments);
            reply(response, 200, { id, state: "pending" });
          }
        }
      } finally { clearTimeout(deadline); active--; }
    } catch (error) {
      if (!response.destroyed) reply(response, error instanceof GuestError ? error.status : 503, { error: error instanceof GuestError ? error.code : "unavailable" });
      // Credentials, URLs, raw input and internal exception messages never enter logs.
      request.resume();
    }
    return true;
  };
}
