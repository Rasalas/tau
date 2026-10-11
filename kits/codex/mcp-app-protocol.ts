import type { FrameColorScheme, SandboxFrameCsp, SandboxFramePermissions } from "tau/host-extension";

/**
 * MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) in a
 * Codex thread, as the host half and the window half of the kit share it.
 * ADR 0032 has the decisions behind the shapes.
 */

export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_RESOURCE_SCHEME = "ui://";
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

/** Key in `UiToolRun.extras` of a tool run that has an app; the value is a `McpAppRef`. */
export const MCP_APP_EXTRA = "tau.codex.mcp-app";

/** What a finished `mcpToolCall` item says about its app; the window matches on this, the host resolves the rest. */
export interface McpAppRef {
  server: string;
  tool: string;
  resourceUri: string;
}

/** Limits that hold on both halves. */
export const MCP_APP_LIMITS = {
  /** A captured document, in bytes. */
  htmlBytes: 5 * 1024 * 1024,
  /** One bridge message, in bytes. */
  messageBytes: 256 * 1024,
  /** Requests an app may have in flight. */
  pendingRequests: 16,
  /** One `ui/download-file` file, in bytes. */
  downloadBytes: 25 * 1024 * 1024,
  /** What `ui/update-model-context` may hold per app, in bytes of JSON. */
  modelContextBytes: 64 * 1024,
  /** Apps kept per thread, and the bytes they may take together. */
  appsPerThread: 40,
  bytesPerThread: 50 * 1024 * 1024,
} as const;

/** Host commands of the Codex kit that serve the app card. All take `threadId` and `itemId` (the tool run's id). */
export const MCP_APP_COMMANDS = {
  open: "mcp-app-open",
  release: "mcp-app-release",
  callTool: "mcp-app-call-tool",
  readResource: "mcp-app-read-resource",
  sendMessage: "mcp-app-send-message",
  approve: "mcp-app-approve",
  modelContext: "mcp-app-model-context",
} as const;

export interface McpAppTarget {
  threadId: string;
  itemId: string;
}

export interface McpAppCallToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

/** `mcp-app-open` input: mints the frame resource for this client, so the call must come from the client that shows it. */
export interface McpAppOpenInput extends McpAppTarget {
  colorScheme: FrameColorScheme;
}

export type McpAppOpen =
  | {
    state: "ready";
    /** Browser resource path; the client resolves it with `host.resourceUrl`. */
    path: string;
    server: string;
    tool: string;
    resourceUri: string;
    prefersBorder?: boolean;
    permissions?: SandboxFramePermissions;
    csp?: SandboxFrameCsp;
    /** The server's MCP `Tool` definition, when the server could be asked. */
    toolDefinition?: unknown;
    /** The call that made the app: its arguments, and its result as the server answered. */
    toolInput: unknown;
    toolResult?: McpAppCallToolResult;
    /** The thread has a live Codex session, so tool calls and reads can reach the server. */
    live: boolean;
  }
  /** The document is still being read from the server. */
  | { state: "pending" }
  | { state: "unavailable"; reason: string };

export interface McpAppCallToolInput extends McpAppTarget {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpAppReadResourceInput extends McpAppTarget {
  uri: string;
}

export interface McpAppSendMessageInput extends McpAppTarget {
  text: string;
}

/** Asks on the thread's prompt cards; answers whether the user allowed it. */
export interface McpAppApproveInput extends McpAppTarget {
  kind: "download";
  /** File names to show. */
  names: string[];
}

export interface McpAppModelContextInput extends McpAppTarget {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}
