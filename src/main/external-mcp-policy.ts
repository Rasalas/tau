import { createHash } from "node:crypto";

export const EXTERNAL_MCP_SCOPES = ["tau:read", "tau:threads"] as const;
export type ExternalMcpScope = typeof EXTERNAL_MCP_SCOPES[number];
export type ExternalMcpExecution = "read-only" | "ask" | "auto" | "full";

export class McpOAuthError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "access_denied" | "temporarily_unavailable") {
    super(code);
    this.name = "McpOAuthError";
  }
}

export function mcpIssuer(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value) return value;
  } catch { /* Reject malformed URLs alongside noncanonical origins. */ }
  throw new McpOAuthError("invalid_request");
}

function redirectUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (value.length <= 2048 && /^https?:\/\//u.test(value) && !value.includes("\\") && !/[\p{Cc}\p{Cf}]/u.test(value) && !url.username && !url.password && !url.hash
      && !value.includes("#") && (url.protocol === "https:" || (url.protocol === "http:" && loopbackIp(url)))) return url;
  } catch { /* Redirects are never fetched or repaired. */ }
  throw new McpOAuthError("invalid_request");
}

function loopbackIp(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function mcpRedirects(values: readonly string[]): string[] {
  if (!values.length || values.length > 8) throw new McpOAuthError("invalid_request");
  for (const value of values) redirectUrl(value);
  return [...new Set(values)];
}

export function matchesMcpRedirect(registered: string, requested: string): boolean {
  const actual = redirectUrl(requested);
  const expected = redirectUrl(registered);
  if (registered === requested) return true;
  // RFC 8252 permits a native loopback IP callback to choose its listening port.
  // Compare the original strings with only the authority's port removed, so URL
  // normalization cannot accidentally permit a different path or query.
  if (expected.protocol !== "http:" || actual.protocol !== "http:" || !loopbackIp(expected) || expected.hostname !== actual.hostname) return false;
  const withoutPort = (value: string) => value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::[0-9]+)?(?=\/|\?|$)/u, "$1");
  return withoutPort(registered) === withoutPort(requested);
}

export function mcpScopes(value = "tau:read"): ExternalMcpScope[] {
  if (value.length > 64) throw new McpOAuthError("invalid_scope");
  const parts = value.split(" ");
  if (parts.length > 2 || !parts.includes("tau:read") || parts.some((part) => !EXTERNAL_MCP_SCOPES.includes(part as ExternalMcpScope))) {
    throw new McpOAuthError("invalid_scope");
  }
  return [...new Set(parts)] as ExternalMcpScope[];
}

export function mcpChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validMcpVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier);
}
