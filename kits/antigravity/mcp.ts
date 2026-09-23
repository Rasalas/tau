import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostMcpConnection } from "tau/host-extension";

/**
 * The MCP servers the user configured for Gemini, forwarded to the agent on
 * `session/new`. The private `GEMINI_HOME` the server runs in holds none, so
 * without this the user's own servers would be invisible in Tau and present
 * everywhere else. Tau reads the file and never writes it.
 */
export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "sse"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export function geminiConfigDirectory(home: string = homedir()): string {
  return join(home, ".gemini");
}

function pairs(value: unknown): Array<{ name: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, entry]) => typeof entry === "string" ? [{ name, value: entry }] : []);
}

/** One entry of Gemini's `mcpServers` map in ACP's shape; anything Tau cannot express is left out. */
export function toAcpMcpServer(name: string, entry: unknown): AcpMcpServer | undefined {
  if (!name.trim() || !entry || typeof entry !== "object") return undefined;
  const config = entry as Record<string, unknown>;
  const headers = pairs(config.headers);
  if (typeof config.httpUrl === "string" && config.httpUrl) return { type: "http", name, url: config.httpUrl, headers };
  if (typeof config.url === "string" && config.url) return { type: "sse", name, url: config.url, headers };
  if (typeof config.command === "string" && config.command) {
    const args = Array.isArray(config.args) ? config.args.filter((argument): argument is string => typeof argument === "string") : [];
    return { name, command: config.command, args, env: pairs(config.env) };
  }
  return undefined;
}

export function mcpServersFromSettings(settings: unknown): AcpMcpServer[] {
  if (!settings || typeof settings !== "object") return [];
  const servers = (settings as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>).flatMap((entry) => {
    const server = toAcpMcpServer(entry[0], entry[1]);
    return server ? [server] : [];
  });
}

/** Reads `<geminiDir>/settings.json`; a missing or broken file simply means no servers. */
export async function readMcpServers(geminiDir: string = geminiConfigDirectory()): Promise<AcpMcpServer[]> {
  try {
    return mcpServersFromSettings(JSON.parse(await readFile(join(geminiDir, "settings.json"), "utf8")));
  } catch {
    return [];
  }
}

/**
 * The servers a session starts with: the user's own and Tau's, which carries
 * the thread's credential. A user server of the same name gives way to Tau's.
 */
export function withTauServer(servers: readonly AcpMcpServer[], tau: HostMcpConnection | undefined): AcpMcpServer[] {
  if (!tau) return [...servers];
  const headers = Object.entries(tau.headers).map(([name, value]) => ({ name, value }));
  return [...servers.filter((server) => server.name !== tau.name), { type: "http", name: tau.name, url: tau.url, headers }];
}
