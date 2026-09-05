import { HOST_CAPABILITY } from "../shared/host-transport.js";

/** Set to `1` to let loopback socket clients treat this host's files as their own. */
export const LOCAL_FILES_ENV = "TAU_HOST_LOCAL_FILES";

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return host === "::1" || host === "localhost" || /^127\./u.test(host);
}

/**
 * Whether one socket client may be told `local-files`. In-process Electron IPC
 * always may; a socket client only when it is on this machine and the operator
 * asked for it, because a client that believes a path is local will show it and
 * open it there.
 */
export function socketCapabilities(
  base: readonly string[],
  peerAddress: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const local = env[LOCAL_FILES_ENV] === "1" && isLoopbackPeer(peerAddress);
  return local ? [...base, HOST_CAPABILITY.localFiles] : [...base];
}
