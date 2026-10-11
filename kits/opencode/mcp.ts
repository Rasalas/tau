import type { HostMcpConnection } from "tau/host-extension";
import { TAU_MCP_SERVER } from "./events.js";

/**
 * Tau's MCP server as OpenCode config, laid over the user's through
 * `OPENCODE_CONFIG_CONTENT` of the thread's own server, so the credential
 * stays in that process's environment. OpenCode does not ask before these
 * tools (`rulesForLevel` allows them): Tau's own gate does.
 * OpenCode 2 reads `mcp.servers` and puts MCP tools behind its Code Mode
 * unless a server opts out; Tau's tools stay direct calls, which its cards know.
 */
export function openCodeMcpConfig(server: HostMcpConnection, generation: 1 | 2 = 1): Record<string, unknown> {
  const remote = { type: "remote", url: server.url, headers: { ...server.headers }, oauth: false };
  return generation === 2
    ? { mcp: { servers: { [TAU_MCP_SERVER]: { ...remote, codemode: false } } } }
    : { mcp: { [TAU_MCP_SERVER]: { ...remote, enabled: true } } };
}
