import type { HostMcpConnection } from "tau/host-extension";

/** Where the app-server reads the thread's credential; the token stays out of its argument list. */
export const TAU_MCP_TOKEN_VARIABLE = "TAU_MCP_TOKEN";

/** Tau's tools may wait on a sub-agent for up to 30 minutes; Codex's own default is one minute. */
const TOOL_TIMEOUT_SEC = 35 * 60;

/**
 * Tau's MCP server as `codex app-server -c` overrides, beside whatever the
 * user's `config.toml` lists. Codex does not ask before these tools: Tau's own
 * gate does, as it does for Pi, and a second question would repeat the first.
 */
export function codexMcpLaunch(server: HostMcpConnection): { args: string[]; env: Record<string, string> } {
  const key = `mcp_servers.${server.name}`;
  return {
    args: [
      "-c", `${key}.url=${JSON.stringify(server.url)}`,
      "-c", `${key}.bearer_token_env_var=${JSON.stringify(TAU_MCP_TOKEN_VARIABLE)}`,
      "-c", `${key}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
      "-c", `${key}.default_tools_approval_mode="approve"`,
    ],
    env: { [TAU_MCP_TOKEN_VARIABLE]: server.token },
  };
}
