import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { isLoopbackHost } from "./host-listen.js";
import type { AccessPeer } from "./host-access.js";
import { peerAddress, type ListenerTrust } from "./host-local-files.js";

/** Everything the built client is made of; anything else is not served at all. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const MAX_BODY_BYTES = 4096;
const AUTH_MAX_SOURCES = 1024;
const AUTH_IDLE_MS = 10 * 60 * 1000;
const AUTH_MAX_BACKOFF_MS = 60 * 1000;

/** `strict`: no larger burst for loopback, for a listener where 127.0.0.1 is anyone. */
export function createAuthRateLimiter(now: () => number = Date.now, options: { strict?: boolean } = {}): (source: string | undefined) => number {
  const sources = new Map<string, { attempts: number; retryAt: number; expiresAt: number }>();
  return (source) => {
    const key = (source ?? "unknown").toLowerCase().replace(/^::ffff:/u, "");
    const time = now();
    let entry = sources.get(key);
    if (entry && entry.expiresAt <= time) {
      sources.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (sources.size >= AUTH_MAX_SOURCES) {
        for (const [address, state] of sources) {
          if (state.expiresAt <= time) sources.delete(address);
        }
        if (sources.size >= AUTH_MAX_SOURCES) return AUTH_MAX_BACKOFF_MS;
      }
      entry = { attempts: 0, retryAt: time, expiresAt: time + AUTH_IDLE_MS };
      sources.set(key, entry);
    }
    if (entry.retryAt > time) return entry.retryAt - time;
    const burst = !options.strict && isLoopbackHost(key) ? 20 : 5;
    entry.attempts = Math.min(entry.attempts + 1, burst + 6);
    entry.retryAt = time + (entry.attempts < burst ? 0 : Math.min(1000 * 2 ** (entry.attempts - burst), AUTH_MAX_BACKOFF_MS));
    entry.expiresAt = time + AUTH_IDLE_MS;
    return 0;
  };
}

export interface WebClientServerOptions {
  /** The built client, normally `dist-web/`. */
  dir: string;
  /** Trades a single-use pairing code for a token of the client's own (`HostAccess.redeem`). */
  pairing: { redeem(code: string, peer: AccessPeer): Promise<string | undefined> };
  now?(): number;
  /** Serve over HTTPS; the socket transport then upgrades on the same TLS port. */
  tls?: { cert: string; key: string };
  /** What the server this builds may conclude about its peers; `loopback` by default. */
  trust?: ListenerTrust;
}

export interface WebClientServer {
  /** The socket transport attaches to this, so client and protocol share one port. */
  server: Server;
  /** The same client for another listener; each kind of listener counts pairing attempts apart. */
  handler(trust: ListenerTrust): RequestListener;
}

/**
 * The static half of a listening host: it serves the built web client on the
 * same port its socket listens on, and it trades a single-use pairing code for
 * a token of the browser's own. The code travels in the link's fragment, which
 * no proxy and no server log ever sees, and the page drops it from its URL
 * before it does anything else. The host token is never handed out here; the
 * owner can still paste it by hand.
 */
export function createWebClientServer(options: WebClientServerOptions): WebClientServer {
  const root = resolve(options.dir);
  const now = options.now ?? Date.now;
  // Apart, so a flood through a proxy (every peer 127.0.0.1) never locks out this machine's own browser.
  const limiters: Record<ListenerTrust, (source: string | undefined) => number> = {
    loopback: createAuthRateLimiter(now),
    network: createAuthRateLimiter(now, { strict: true }),
    proxy: createAuthRateLimiter(now, { strict: true }),
  };

  const handler = (trust: ListenerTrust): RequestListener => (request, response) => {
    void handle(request, response, trust).catch(() => send(response, 500, "text/plain; charset=utf-8", "internal error"));
  };
  const listener = handler(options.trust ?? "loopback");
  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, listener)
    : createServer(listener);

  async function handle(request: IncomingMessage, response: ServerResponse, trust: ListenerTrust): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/pair") {
      if (request.method !== "POST") { send(response, 405, "text/plain; charset=utf-8", "use POST"); return; }
      const address = peerAddress(trust, request);
      const retryAfterMs = limiters[trust](address);
      if (retryAfterMs > 0) {
        request.resume();
        response.setHeader("retry-after", Math.ceil(retryAfterMs / 1000));
        send(response, 429, "application/json; charset=utf-8", JSON.stringify({ error: "too many pairing attempts" }));
        return;
      }
      const body = await readBody(request);
      const code = typeof body?.code === "string" ? body.code : "";
      const userAgent = request.headers["user-agent"];
      const token = code ? await options.pairing.redeem(code, {
        ...(address ? { address } : {}),
        ...(typeof userAgent === "string" ? { userAgent } : {}),
      }) : undefined;
      // A refused code says nothing about why: expired, spent and invented are one answer.
      if (!token) { send(response, 403, "application/json; charset=utf-8", JSON.stringify({ error: "unknown pairing code" })); return; }
      // No store: the answer is a credential.
      response.setHeader("cache-control", "no-store");
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({ token }));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { send(response, 405, "text/plain; charset=utf-8", "use GET"); return; }
    const file = resolveAsset(root, url.pathname);
    if (!file) { send(response, 404, "text/plain; charset=utf-8", "not found"); return; }
    const content = await readFile(file).catch(() => undefined);
    if (!content) { send(response, 404, "text/plain; charset=utf-8", "not found"); return; }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    // The client is served from the host's own tree and changes with it: an
    // asset carries a content hash, index.html must never be a stale one.
    response.writeHead(200, {
      "content-type": type,
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
      "content-length": content.byteLength,
      // The page talks to its own origin and nowhere else.
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  }

  return { server, handler };
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Maps a request path to a file inside the built client, or to nothing. `/`
 * is the client; every other path is an asset that must exist, so a typo is a
 * 404 rather than the app served under a name it does not have.
 */
export function resolveAsset(root: string, pathname: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (decoded === "/" || decoded === "") return join(root, "index.html");
  // Strip the leading separator before normalising, so a `..` that would leave
  // the built client survives as one and the check below sees it.
  const relative = normalize(decoded.replace(/^[/\\]+/u, ""));
  if (!relative || relative === "." || relative.startsWith("..")) return undefined;
  const file = resolve(root, relative);
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
