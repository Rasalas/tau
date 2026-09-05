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

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return LOOPBACK_NAMES.has(bare.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/u.test(bare);
}

/**
 * The socket carries its bearer token in clear text, so a public interface
 * would hand it to everyone on the path. Loopback plus an SSH tunnel is the
 * supported way to reach a host on another machine; `TAU_HOST_INSECURE=1` is
 * the deliberate exception for a network the operator already trusts.
 */
export function assertListenAllowed(address: ListenAddress, allowNonLoopback: boolean): void {
  if (allowNonLoopback || isLoopbackHost(address.host)) return;
  throw new Error(
    `Refusing to listen on ${address.host}: the host protocol is unencrypted. `
    + "Bind 127.0.0.1 and forward the port over SSH, or set TAU_HOST_INSECURE=1 to bind anyway.",
  );
}
