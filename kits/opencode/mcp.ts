import type { HostMcpConnection } from "tau/host-extension";
import { TAU_MCP_SERVER } from "./events.js";

/**
 * Tau's MCP server as OpenCode config, laid over the user's through
 * `OPENCODE_CONFIG_CONTENT` of the thread's own server, so the credential
 * stays in that process's environment. OpenCode does not ask before these
 * tools (`rulesForLevel` allows them): Tau's own gate does.
 */
export function openCodeMcpConfig(server: HostMcpConnection): Record<string, unknown> {
  return {
    mcp: {
      [TAU_MCP_SERVER]: { type: "remote", url: server.url, headers: { ...server.headers }, oauth: false, enabled: true },
    },
  };
}
