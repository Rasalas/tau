import { isLoopbackPeer } from "./host-local-files.js";

/** Extra page origins a host accepts sockets from, comma-separated (a native shell's, a proxy's public name). */
export const ALLOWED_ORIGINS_ENV = "TAU_HOST_ALLOWED_ORIGINS";

/** What the upgrade request tells about who opened the socket. */
export interface SocketOrigin {
  /** The `Origin` header; a browser always sends one, other clients usually none. */
  origin?: string;
  /** The `Host` header: the name the page used to reach this listener. */
  host?: string;
  peerAddress?: string;
}

/**
 * Whether a socket may talk to this host at all. The token in the hello is the
 * real gate; this keeps a page on another site from even trying one. No
 * `Origin` is a client that is not a browser page. A page is let in when it
 * came from this listener, is named in `allowed`, or is Electron's `file://`
 * window on this machine.
 */
export function originAllowed(request: SocketOrigin, allowed: readonly string[] = []): boolean {
  const origin = request.origin?.trim();
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (normalized && allowed.some((entry) => normalizeOrigin(entry) === normalized)) return true;
  if (origin === "file://") return isLoopbackPeer(request.peerAddress);
  if (!normalized || !request.host || !/^https?:/u.test(normalized)) return false;
  return new URL(normalized).host === request.host.trim().toLowerCase();
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
