import { existsSync } from "node:fs";

/** Where an administrator installs the CLI's `managed-mcp.json`, per platform. */
export function managedMcpConfigPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

/**
 * Whether the machine has one. The CLI exits before it initializes when given
 * `--strict-mcp-config` next to it, and the managed file already keeps every
 * other MCP server out, so callers that pass the flag for isolation drop it.
 */
export function hasManagedMcpConfig(platform?: NodeJS.Platform, exists: (path: string) => boolean = existsSync): boolean {
  try {
    return exists(managedMcpConfigPath(platform));
  } catch {
    return false;
  }
}
