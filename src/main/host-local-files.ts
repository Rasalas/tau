import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { HOST_CAPABILITY } from "../shared/host-transport.js";

/** Set to `1` to let loopback socket clients treat this host's files as their own. */
export const LOCAL_FILES_ENV = "TAU_HOST_LOCAL_FILES";

/**
 * What a listener may conclude from a peer's address. `loopback`: a loopback
 * peer is this machine. `network`: nothing is local, whatever the address.
 * `proxy`: bound on loopback but fed by a reverse proxy such as `tailscale
 * serve`, so every peer shows up as 127.0.0.1 and none of them is local.
 */
export type ListenerTrust = "loopback" | "network" | "proxy";

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return host === "::1" || host === "localhost" || /^127\./u.test(host);
}

/** A peer on this machine: only a loopback listener can tell. */
export function isLocalPeer(trust: ListenerTrust, address: string | undefined): boolean {
  return trust === "loopback" && isLoopbackPeer(address);
}

/**
 * The peer's address as a person should read it. Behind a proxy that is the
 * last `X-Forwarded-For` hop, the one the proxy itself added; earlier hops
 * are whatever the client claimed.
 */
export function peerAddress(trust: ListenerTrust, request: IncomingMessage): string | undefined {
  const socketAddress = request.socket.remoteAddress;
  if (trust !== "proxy") return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((hop) => hop.trim()).filter(Boolean).at(-1);
  return forwarded && isIP(forwarded) ? forwarded : socketAddress;
}

/**
 * Whether one socket client may be told `local-files`. In-process Electron IPC
 * always may; a socket client only when it is on this machine and the operator
 * asked for it, because a client that believes a path is local will show it and
 * open it there.
 */
export function socketCapabilities(
  base: readonly string[],
  peer: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  trust: ListenerTrust = "loopback",
): string[] {
  const local = env[LOCAL_FILES_ENV] === "1" && isLocalPeer(trust, peer);
  return local ? [...base, HOST_CAPABILITY.localFiles] : [...base];
}
