import { readFileSync, writeFileSync } from "node:fs";

/** A parsed `TAU_HOST_LISTEN`; port 0 lets the OS pick a free one. */
export interface ListenAddress {
  host: string;
  port: number;
}

export function parseListen(listen: string): ListenAddress {
  const separator = listen.lastIndexOf(":");
  if (separator < 0) return { host: "127.0.0.1", port: Number(listen) };
  return { host: listen.slice(0, separator) || "127.0.0.1", port: Number(listen.slice(separator + 1)) };
}

function formatListen(host: string, port: number): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

/**
 * Port 0 asks again for the port this host bound last, while it is free: a
 * browser tab or phone keeps its page's address, and so the token stored for
 * that origin, across a restart of the app. Any port otherwise.
 */
export async function stickyListen(listen: string, lastPort: number | undefined, isFree: (host: string, port: number) => Promise<boolean>): Promise<string> {
  const { host, port } = parseListen(listen);
  if (port !== 0 || !lastPort) return listen;
  return await isFree(host, lastPort) ? formatListen(host, lastPort) : listen;
}

/** The port `rememberPort` kept in `file`, if any. */
export function rememberedPort(file: string): number | undefined {
  try {
    const port = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function rememberPort(file: string, port: number): void {
  try { writeFileSync(file, `${port}\n`, { mode: 0o600 }); } catch { /* a read-only userData keeps the old behaviour */ }
}

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return LOOPBACK_NAMES.has(bare.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/u.test(bare);
}

export interface ListenPolicy {
  /** The listener speaks TLS, so the token never crosses the network in clear text. */
  encrypted: boolean;
  /** `TAU_HOST_INSECURE=1`: the operator accepts a plaintext listener beyond loopback. */
  insecure: boolean;
}

/**
 * The socket carries its bearer token in every hello, so a plaintext listener
 * beyond loopback would hand it to everyone on the path. TLS makes any
 * interface acceptable; `TAU_HOST_INSECURE=1` is the deliberate exception for
 * a network the operator already trusts, and it is answered with a warning to
 * print, never silently.
 */
export function assertListenAllowed(address: ListenAddress, policy: ListenPolicy): { warning?: string } {
  if (policy.encrypted || isLoopbackHost(address.host)) return {};
  if (policy.insecure) {
    return {
      warning: `TAU_HOST_INSECURE=1: listening on ${address.host} without TLS. The host token travels in clear text, `
        + "and whoever reads it controls this host. Set TAU_HOST_TLS=1 instead.",
    };
  }
  throw new Error(
    `Refusing to listen on ${address.host} without TLS: the host token would travel in clear text. `
    + "Set TAU_HOST_TLS=1 (a self-signed certificate clients pin by fingerprint) or TAU_HOST_TLS_CERT and TAU_HOST_TLS_KEY, "
    + "bind 127.0.0.1 and forward the port over SSH, or set TAU_HOST_INSECURE=1 to bind anyway.",
  );
}
