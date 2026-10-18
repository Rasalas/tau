export const MCP_USAGE = `Usage: tau mcp status
       tau mcp register --name <name> --redirect <exact callback URL> [--redirect <URL>]
       tau mcp approve <request-id> --project <project-id> [--project <id>]
       tau mcp deny <request-id>
       tau mcp revoke <grant-id>
       tau mcp remove <client-id>

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
30 days and may be revoked immediately. This release offers read-only projects,
thread summaries and conversation text; thread control is unavailable.

All output is JSON. Only the machine's local access-key connection may manage
these grants. TAU_USER_DATA selects an isolated instance.`;

export function parseMcpArgs(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) return { help: true };
  const [action, ...rest] = args;
  if (action === "status" && !rest.length) return { action };
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
      if (rest[i] !== "--project" || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(MCP_USAGE);
      result.projectIds.push(rest[i + 1]);
    }
    if (!result.projectIds.length) throw new Error(MCP_USAGE);
  } else if (rest.length !== 1) throw new Error(MCP_USAGE);
  return result;
}

export async function runMcp(options, { session, out }) {
  if (options.help) { out(MCP_USAGE); return 0; }
  out(JSON.stringify(await session.request("external-mcp-manage", [options])));
  return 0;
}
