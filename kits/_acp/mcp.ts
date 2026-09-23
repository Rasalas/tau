import type { HostMcpConnection } from "tau/host-extension";

/** An MCP server in the shape `session/new` takes it. */
export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

/**
 * The servers a session starts with: the user's own and Tau's, which carries
 * the thread's credential (ADR 0022). A user server of the same name gives way to Tau's.
 */
export function withTauServer(servers: readonly AcpMcpServer[], tau: HostMcpConnection | undefined): AcpMcpServer[] {
  if (!tau) return [...servers];
  const headers = Object.entries(tau.headers).map(([name, value]) => ({ name, value }));
  return [...servers.filter((server) => server.name !== tau.name), { type: "http", name: tau.name, url: tau.url, headers }];
}
