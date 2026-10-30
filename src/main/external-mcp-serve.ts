import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExternalMcpAuthorization } from "./external-mcp-authorization.js";
import { EXTERNAL_MCP_CONTROL_TOOLS, callExternalMcpControlTool, isExternalMcpControlTool, type ExternalMcpControlHost } from "./external-mcp-control-tools.js";
import { McpOAuthError } from "./external-mcp-policy.js";
import { EXTERNAL_MCP_READ_TOOLS, callExternalMcpReadTool, type ExternalMcpReadHost } from "./external-mcp-read-tools.js";
import { ExternalMcpRefusal, type ExternalMcpThreads } from "./external-mcp-threads.js";

/** What one authenticated external MCP request runs with, on either listener. */
export interface ExternalMcpServeContext {
  auth: ExternalMcpAuthorization;
  token: string;
  host(): Promise<ExternalMcpControlHost>;
  /** Absent: thread control is not offered, whatever the grant holds. */
  threads?: ExternalMcpThreads;
  version: string;
  /** Transcript reads in flight on this listener; their I/O keeps its slot until it settles. */
  reads: Set<Promise<unknown>>;
  log?(label: string, detail?: string): void;
}

/** A host's reason helps a client fix its call (an unknown runtime, say); one that names a local path stays in the log. */
function controlFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message && message.length <= 300 && !/(^|[\s"'(`])(\/|~\/|[A-Za-z]:\\)/u.test(message) && error instanceof Error && error.name !== "AbortError"
    ? message : "Tau could not do this. The machine's owner can see why in Tau's log.";
}

function toolsFor(context: ExternalMcpServeContext) {
  const grant = context.auth.authenticate(context.token, context.auth.resource);
  if (!grant) throw new McpOAuthError("invalid_grant");
  const control = context.threads && grant.scopes.includes("tau:threads");
  return { grant, tools: [...EXTERNAL_MCP_READ_TOOLS, ...(control ? EXTERNAL_MCP_CONTROL_TOOLS : [])] };
}

/** One stateless JSON-RPC request: a fresh server, the grant's tool list, every call re-authorized. */
export async function serveExternalMcp(context: ExternalMcpServeContext, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/server/streamableHttp.js"), import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const { grant } = toolsFor(context);
  const control = context.threads && grant.scopes.includes("tau:threads");
  const instructions = control
    ? `Access to the projects approved by the machine's owner. This client may start threads and steer or stop the threads it started; they run under a "${grant.execution}" execution ceiling. Other threads are read-only.`
    : "Read-only access to the projects approved by the machine's owner. Thread control is unavailable.";
  const server = new Server({ name: "tau-external", title: "Tau", version: context.version }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(context).tools.map((tool) => ({ ...tool, inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as { type: "object" }, annotations: { ...tool.annotations } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    const name = call.params.name;
    try {
      const host = await context.host();
      if (isExternalMcpControlTool(name)) {
        if (!context.threads) throw new McpOAuthError("access_denied");
        return await callExternalMcpControlTool(context.auth, context.token, host, context.threads, name, call.params.arguments ?? {}, extra.signal);
      }
      const bounded: ExternalMcpReadHost = {
        threadIndexSnapshot: () => host.threadIndexSnapshot(),
        loadTranscript: (threadId, cursor) => {
          if (context.reads.size >= 16) return Promise.reject(new McpOAuthError("temporarily_unavailable"));
          const pending = host.loadTranscript(threadId, cursor);
          context.reads.add(pending);
          // Cancellation ends the client call immediately, but the actual I/O
          // retains its slot until it settles, even after its grant is revoked.
          void pending.finally(() => context.reads.delete(pending)).catch(() => undefined);
          return pending;
        },
      };
      return await callExternalMcpReadTool(context.auth, context.token, bounded, name, call.params.arguments ?? {}, extra.signal);
    } catch (error) {
      if (!(error instanceof McpOAuthError) && !(error instanceof ExternalMcpRefusal)) context.log?.("external-mcp.call-failed", `${name}: ${error instanceof Error ? error.message : String(error)}`);
      const text = error instanceof McpOAuthError ? error.code : error instanceof ExternalMcpRefusal ? error.message
        : isExternalMcpControlTool(name) ? controlFailure(error) : "Read cancelled or unavailable.";
      return { isError: true, content: [{ type: "text", text }] };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once("close", () => { void transport.close().catch(() => undefined); void server.close().catch(() => undefined); });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
