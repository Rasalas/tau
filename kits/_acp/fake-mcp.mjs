import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Calls a real Tau MCP endpoint from a scripted ACP agent; no model or account is involved. */
export async function fakeMcpCall(servers, prompt) {
  const match = /\bmcp\s+(\S+)(?:\s+(\{.*\}))?/su.exec(prompt);
  if (!match) return undefined;
  const server = servers.find((entry) => entry.name === "tau" && entry.type === "http");
  if (!server) return "MCP unavailable";
  const headers = Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value]));
  const client = new Client({ name: "scripted-acp", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    const result = await client.callTool({ name: match[1], arguments: JSON.parse(match[2] ?? "{}") });
    return `${result.isError ? "Error: " : ""}${(result.content ?? []).map((item) => item.text ?? "").join("\n")}`;
  } finally { await client.close(); }
}
