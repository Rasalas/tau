/** The execution ceiling of a client that may start threads, strictest first (ADR 0046). */
export type UiMcpExecution = "read-only" | "ask" | "auto" | "full";

export const MCP_EXECUTION_LABELS: Record<UiMcpExecution, string> = {
  "read-only": "Read only",
  ask: "Ask before edits",
  auto: "Auto review",
  full: "Full access",
};

/** A local MCP token as the owner's Settings page lists it; never its secret. */
export interface UiLocalMcpToken {
  id: string;
  name: string;
  scopes: Array<"tau:read" | "tau:threads">;
  projectIds: string[];
  execution: UiMcpExecution;
  createdAt: number;
  /** Absent: it never expires. */
  expiresAt?: number;
}

/** `external-mcp-manage` `local-status`, `local-enable` and `local-disable`. */
export interface UiLocalMcpStatus {
  enabled: boolean;
  listening: boolean;
  url?: string;
  port?: number;
  /** Why an enabled listener is not listening, e.g. its port is taken. */
  problem?: string;
  protocolVersion: string;
  tokens: UiLocalMcpToken[];
  projects: Array<{ id: string; name: string }>;
}

/** `external-mcp-manage` `local-create`: the only time the token itself is shown. */
export interface UiLocalMcpCreated {
  token: string;
  id: string;
  url?: string;
}

/** The environment variable the Codex snippet and `tau mcp` read the token from. */
export const MCP_TOKEN_ENV = "TAU_MCP_TOKEN";

/**
 * Configuration a client on this machine pastes. The Codex keys follow
 * `codex mcp add --url … --bearer-token-env-var …` (codex-cli 0.165).
 */
export function localMcpClientConfigs(url: string, token: string): Array<{ id: string; label: string; text: string }> {
  return [
    { id: "claude-code", label: "Claude Code", text: `claude mcp add --transport http tau ${url} --header "Authorization: Bearer ${token}"` },
    { id: "codex", label: "Codex", text: `codex mcp add tau --url ${url} --bearer-token-env-var ${MCP_TOKEN_ENV}\n# ~/.codex/config.toml then holds:\n# [mcp_servers.tau]\n# url = "${url}"\n# bearer_token_env_var = "${MCP_TOKEN_ENV}"\n# Start Codex with the token in its environment:\nexport ${MCP_TOKEN_ENV}=${token}` },
    { id: "json", label: "JSON", text: JSON.stringify({ mcpServers: { tau: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
    { id: "stdio", label: "stdio", text: JSON.stringify({ mcpServers: { tau: { command: "tau", args: ["mcp", "serve"], env: { [MCP_TOKEN_ENV]: token } } } }, null, 2) },
  ];
}
