import { readFrameCsp, readFramePermissions, type SandboxFrameCsp, type SandboxFramePermissions } from "tau/host-extension";
import { MCP_APP_LIMITS, MCP_APP_MIME_TYPE } from "./mcp-app-protocol.js";
import type { CodexMcpResourceRead } from "./app-server.js";

export interface McpAppDocument {
  html: string;
  csp?: SandboxFrameCsp;
  permissions?: SandboxFramePermissions;
  prefersBorder?: boolean;
}

export type McpAppDocumentRead = { document: McpAppDocument } | { reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The app's HTML in a `resources/read` answer. Only the entry for `uri` with
 * the MCP App media type counts. Sizes are checked before a blob is decoded.
 */
export function readAppDocument(read: Pick<CodexMcpResourceRead, "contents"> | undefined, uri: string, maxBytes = MCP_APP_LIMITS.htmlBytes): McpAppDocumentRead {
  const entry = (Array.isArray(read?.contents) ? read.contents : []).find((content) =>
    isRecord(content) && content.uri === uri && typeof content.mimeType === "string" && content.mimeType.replace(/\s+/gu, "").toLowerCase() === MCP_APP_MIME_TYPE);
  if (!entry) return { reason: "The server returned no app document." };
  let html: string;
  if (typeof entry.text === "string") {
    // UTF-8 takes at least one byte per character.
    if (entry.text.length > maxBytes) return { reason: "The app's document is too large." };
    html = entry.text;
  } else if (typeof entry.blob === "string") {
    if (entry.blob.length > Math.ceil(maxBytes / 3) * 4) return { reason: "The app's document is too large." };
    html = Buffer.from(entry.blob, "base64").toString("utf8");
  } else return { reason: "The server returned no app document." };
  if (!html.trim()) return { reason: "The server returned no app document." };
  if (Buffer.byteLength(html, "utf8") > maxBytes) return { reason: "The app's document is too large." };
  const ui = isRecord(entry["_meta"]) && isRecord(entry["_meta"].ui) ? entry["_meta"].ui : {};
  const csp = readFrameCsp(ui.csp);
  const permissions = readFramePermissions(ui.permissions);
  return {
    document: {
      html,
      ...(csp ? { csp } : {}),
      ...(permissions ? { permissions } : {}),
      ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
    },
  };
}
