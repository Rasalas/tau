import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

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

export interface WebClientServerOptions {
  /** The built client, normally `dist-web/`. */
  dir: string;
  /** Serve over HTTPS; the socket transport then upgrades on the same TLS port. */
  tls?: { cert: string; key: string };
}

export interface WebClientServer {
  /** The socket transport attaches to this, so client and protocol share one port. */
  server: Server;
}

/**
 * The static half of a listening host: it serves the built web client on the
 * same port its socket listens on. Nothing here authenticates or hands out a
 * credential: a browser pairs over the socket like every other client, and
 * the owner still allows it on the host (ADR 0024).
 */
export function createWebClientServer(options: WebClientServerOptions): WebClientServer {
  const root = resolve(options.dir);

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch(() => send(response, 500, "text/plain; charset=utf-8", "internal error"));
  };
  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, listener)
    : createServer(listener);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Pairing moved to the socket, where the owner allows each device (ADR 0024).
    if (url.pathname === "/pair") { request.resume(); send(response, 410, "text/plain; charset=utf-8", "pair over the host socket"); return; }
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

  return { server };
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
