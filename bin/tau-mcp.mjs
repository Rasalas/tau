import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const MCP_USAGE = `Usage: tau mcp status
       tau mcp register --name <name> --redirect <exact callback URL> [--redirect <URL>]
       tau mcp approve <request-id> --project <project-id> [--project <id>] [--threads [--ceiling read-only|ask|auto|full]]
       tau mcp deny <request-id>
       tau mcp revoke <grant-id>
       tau mcp remove <client-id>
       tau mcp serve

tau mcp serve connects an MCP client that only speaks stdio (Claude Desktop,
for instance) to Tau's local MCP listener on this machine. Create a token in
Settings → Connections → MCP clients and pass it as TAU_MCP_TOKEN; TAU_MCP_URL
overrides the listener's address.

Start Tau with TAU_MCP_ORIGIN=https://your-machine.example and a trusted HTTPS
listener or a local TLS reverse proxy. Preserve Host when proxying to Tau's
explicit proxy listener. TAU_MCP_BROWSER_ORIGINS optionally lists exact HTTPS
browser origins, separated by commas. Tau Connect's private WebSocket tunnel
does not publish ordinary MCP HTTP routes.

Register a public OAuth client with its exact HTTPS callback or native loopback
IP callback. Configure that client with its returned client id and the resource
URL from status. Dynamic registration and client metadata URLs are not supported.
When it signs in, status lists its pending request and the available project ids.
Approve only the projects it may read, or deny the request. Grants expire after
30 days and may be revoked immediately. --threads also lets it start threads and
steer or stop the threads it started, under an execution ceiling: ask (the
default), read-only, auto, or full only when named. Revoking stops their turns.

All output is JSON. Only the machine's local access-key connection may manage
these grants. TAU_USER_DATA selects an isolated instance.`;

export function parseMcpArgs(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) return { help: true };
  const [action, ...rest] = args;
  if ((action === "status" || action === "serve") && !rest.length) return { action };
  if (action === "register") {
    const result = { action, redirectUris: [] };
    for (let i = 0; i < rest.length; i += 2) {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error(MCP_USAGE);
      if (rest[i] === "--name" && !result.name) result.name = value;
      else if (rest[i] === "--redirect") result.redirectUris.push(value);
      else throw new Error(MCP_USAGE);
    }
    if (!result.name || !result.redirectUris.length) throw new Error(MCP_USAGE);
    return result;
  }
  const field = { approve: "requestId", deny: "requestId", revoke: "grantId", remove: "clientId" }[action];
  if (!field || !rest[0] || rest[0].startsWith("--")) throw new Error(MCP_USAGE);
  const result = { action, [field]: rest[0] };
  if (action === "approve") {
    result.projectIds = [];
    for (let i = 1; i < rest.length; i += 2) {
      if (rest[i] === "--threads" && !result.scope) { result.scope = "tau:read tau:threads"; i--; continue; }
      if (rest[i] === "--ceiling" && !result.execution && ["read-only", "ask", "auto", "full"].includes(rest[i + 1])) { result.execution = rest[i + 1]; continue; }
      if (rest[i] !== "--project" || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(MCP_USAGE);
      result.projectIds.push(rest[i + 1]);
    }
    if (!result.projectIds.length || (result.execution && !result.scope)) throw new Error(MCP_USAGE);
  } else if (rest.length !== 1) throw new Error(MCP_USAGE);
  return result;
}

export async function runMcp(options, { session, out }) {
  if (options.help) { out(MCP_USAGE); return 0; }
  out(JSON.stringify(await session.request("external-mcp-manage", [options])));
  return 0;
}

/** The local listener's address: TAU_MCP_URL, or the port Tau keeps in its userData while the listener is on. */
export function localMcpUrl(userData, env = process.env) {
  if (env.TAU_MCP_URL) return env.TAU_MCP_URL;
  let settings;
  try { settings = JSON.parse(readFileSync(join(userData, "external-mcp-local.json"), "utf8")); } catch { settings = undefined; }
  if (!settings?.enabled || !Number.isInteger(settings.port)) throw new Error("Tau's local MCP listener is off. Turn it on in Settings → Connections → MCP clients.");
  return `http://127.0.0.1:${settings.port}/mcp`;
}

/**
 * MCP's stdio transport on one side, Tau's local Streamable HTTP listener on
 * the other: each line is one JSON-RPC message, posted with the token; each
 * answer goes back as one line. Notifications get no line.
 */
export async function serveMcpStdio({ url, token, input = process.stdin, output = process.stdout, fetch: send = fetch }) {
  if (!token) throw new Error("Set TAU_MCP_TOKEN to a token from Settings → Connections → MCP clients.");
  let protocolVersion;
  const pending = new Set();
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const forward = async (message) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}) };
    try {
      const response = await send(url, { method: "POST", headers, body: JSON.stringify(message) });
      const text = await response.text();
      if (!response.ok) {
        if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Tau answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}` } });
        return;
      }
      if (!text) return;
      const reply = JSON.parse(text);
      if (message.method === "initialize" && typeof reply.result?.protocolVersion === "string") protocolVersion = reply.result.protocolVersion;
      write(reply);
    } catch (error) {
      if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Tau is unreachable: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    // The answer to initialize carries the version every later request names.
    const work = forward(message);
    if (message.method === "initialize") await work;
    else { pending.add(work); void work.finally(() => pending.delete(work)); }
  }
  await Promise.all(pending);
  return 0;
}
