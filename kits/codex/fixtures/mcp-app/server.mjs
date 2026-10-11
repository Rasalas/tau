// Stdio MCP server with one MCP App (ui://) for verifying the frame and bridge; see stub-model.mjs for the setup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const URI = "ui://fixture/counter.html";
let count = 0;
const server = new McpServer({ name: "fixture", version: "1.0.0" });

server.registerTool("show_counter", {
  description: "Shows the counter view.",
  inputSchema: { start: z.number().optional() },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: URI }, "ui/resourceUri": URI },
}, async ({ start }) => {
  if (typeof start === "number") count = start;
  return { content: [{ type: "text", text: `Counter at ${count}` }], structuredContent: { count } };
});
server.registerTool("peek", {
  description: "Reads the counter.",
  annotations: { readOnlyHint: true },
  _meta: { ui: { visibility: ["app"] } },
}, async () => ({ content: [{ type: "text", text: `peek ${count}` }], structuredContent: { count } }));
server.registerTool("bump", {
  description: "Adds to the counter.",
  inputSchema: { by: z.number().optional() },
  annotations: { readOnlyHint: false },
  _meta: { ui: { visibility: ["app"] } },
}, async ({ by }) => {
  count += typeof by === "number" ? by : 1;
  return { content: [{ type: "text", text: `bumped to ${count}` }], structuredContent: { count } };
});
server.registerTool("model_only", {
  description: "Not callable by the app.",
  annotations: { readOnlyHint: true },
  _meta: { ui: { visibility: ["model"] } },
}, async () => ({ content: [{ type: "text", text: "model only" }] }));
server.registerResource("counter", URI, { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: "text/html;profile=mcp-app",
    text: readFileSync(join(here, "counter.html"), "utf8"),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }],
}));
server.registerResource("notes", "file:///fixture/notes.txt", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: "fixture notes" }],
}));

await server.connect(new StdioServerTransport());
