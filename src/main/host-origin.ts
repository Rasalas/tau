import { isLoopbackHost } from "./host-listen.js";

/** Extra page origins a host accepts sockets from, comma-separated (a native shell's, a proxy's public name). */
export const ALLOWED_ORIGINS_ENV = "TAU_HOST_ALLOWED_ORIGINS";

/** What the upgrade request tells about who opened the socket. */
export interface SocketOrigin {
  /** The `Origin` header; a browser always sends one, other clients usually none. */
  origin?: string;
  /** The `Host` header: the name the page used to reach this listener. */
  host?: string;
  /** The address and port this connection actually reached, including attached listeners. */
  listenerAddress?: string;
  listenerPort?: number;
  /** TLS on the actual listener, not a forwarded protocol header. */
  encrypted?: boolean;
  /** Behind a proxy, the host the page reached the proxy at (`X-Forwarded-Host`); only a proxy listener sets it. */
  forwardedHost?: string;
}

/** Browser origins are checked before a hello or an unauthenticated pairing frame. */
export function originAllowed(request: SocketOrigin, allowed: readonly string[] = []): boolean {
  const origin = request.origin?.trim();
  if (!origin) return true;
  if (/^file:/iu.test(origin)) return false;
  if (!request.encrypted && !hostAllowed(request, allowed)) return false;
  const normalized = normalizeOrigin(origin);
  if (normalized && allowed.some((entry) => normalizeOrigin(entry) === normalized)) return true;
  if (!normalized || !/^https?:/u.test(normalized)) return false;
  const host = new URL(normalized).host;
  if (request.forwardedHost && host === request.forwardedHost.trim().toLowerCase()) return true;
  return host === request.host?.trim().toLowerCase();
}

function hostAllowed(request: SocketOrigin, allowed: readonly string[]): boolean {
  const host = request.host?.trim().toLowerCase();
  if (!host || !/^[^\s/@?#\\]+$/u.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    const port = /:(\d+)$/u.exec(host)?.[1];
    const listenerPort = request.listenerPort;
    const samePort = port ? Number(port) === listenerPort : listenerPort === 80 || listenerPort === 443;
    const address = request.listenerAddress?.replace(/^::ffff:/u, "").replace(/^\[|\]$/gu, "");
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (samePort && (isLoopbackHost(hostname) || hostname === address)) return true;
    if (host === request.forwardedHost?.trim().toLowerCase()) return true;
    return allowed.some((entry) => {
      const normalized = normalizeOrigin(entry);
      if (!normalized || !/^https?:/u.test(normalized)) return false;
      return new URL(`http://${new URL(normalized).host}`).host === url.host;
    });
  } catch {
    return false;
  }
}

/** The last `X-Forwarded-Host` hop, the one the proxy itself added. */
export function forwardedHost(header: string | string[] | undefined): string | undefined {
  const hops = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1);
}

/** `TAU_HOST_ALLOWED_ORIGINS`, plus the dev server a development window loads from. */
export function hostAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env[ALLOWED_ORIGINS_ENV] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const devServer = env.TAU_DEV_SERVER_URL ? normalizeOrigin(env.TAU_DEV_SERVER_URL) : undefined;
  return [...listed, ...(devServer ? [devServer] : [])];
}

/** `scheme://host[:port]` in lower case, default port dropped; undefined for `null`, `file://` and non-URLs. */
function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // A native shell's scheme (`capacitor://localhost`) has no web origin of its own.
    if (url.origin !== "null") return url.origin.toLowerCase();
    return url.host ? `${url.protocol}//${url.host}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
