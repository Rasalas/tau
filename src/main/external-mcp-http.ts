import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { join } from "node:path";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import { isHostOwner } from "./host-invocation.js";
import { ownerRefusal } from "./host-method-access.js";
import type { ListenerTrust } from "./host-local-files.js";
import { createAuthRateLimiter } from "./host-rate-limit.js";
import { ExternalMcpAuthorization } from "./external-mcp-authorization.js";
import { McpOAuthError, isExternalMcpExecution, mcpIssuer, mcpScopes, type ExternalMcpExecution, type ExternalMcpScope } from "./external-mcp-policy.js";
import type { ExternalMcpControlHost } from "./external-mcp-control-tools.js";
import { serveExternalMcp } from "./external-mcp-serve.js";
import type { ExternalMcpThreads } from "./external-mcp-threads.js";

const PATHS = new Set(["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/authorize", "/oauth/consent", "/oauth/token", "/oauth/revoke"]);
const BODY_LIMIT = 64 * 1024;
const REQUEST_LIFETIME = 5 * 60_000;
const MAX_CONSENTS = 64;

interface Consent {
  clientId: string;
  expiresAt: number;
  denialRedirect: string;
  redirect?: string;
  denied?: true;
}

export interface ExternalMcpHttpOptions {
  userData: string;
  issuer: string;
  browserOrigins?: readonly string[];
  host(): Promise<ExternalMcpControlHost>;
  /** Thread control for `tau:threads` grants (ADR 0046); read-only without it. */
  threads?: ExternalMcpThreads;
  version: string;
  log?(label: string, detail?: string): void;
  /** The local backend the owner's HTTPS proxy forwards to. */
  proxyUrl?(): string | undefined;
  now?: () => number;
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpOAuthError("invalid_request");
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value || value.length > max) throw new McpOAuthError("invalid_request");
  return value;
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new McpOAuthError("invalid_request");
  return value.map((entry) => string(entry, 2048));
}

function parameters(params: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new McpOAuthError("invalid_request");
    result[key] = value;
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { request.destroy(); reject(new McpOAuthError("invalid_request")); }, 10_000);
    timer.unref();
    const fail = () => { clearTimeout(timer); reject(new McpOAuthError("invalid_request")); };
    request.once("error", fail);
    request.once("aborted", fail);
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { fail(); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.once("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

/** HTTPS OAuth resource on host-owned listeners, independent of the workbench socket. */
export class ExternalMcpHttp {
  private readonly now: () => number;
  private readonly authRate: (source: string | undefined) => number;
  private readonly origins: Set<string>;
  private readonly consents = new Map<string, Consent>();
  private readonly calls = new Map<string, { until: number; count: number }>();
  private readonly responses = new Set<ServerResponse>();
  private readonly reads = new Set<Promise<unknown>>();
  private management: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(private readonly options: ExternalMcpHttpOptions, private readonly auth: ExternalMcpAuthorization) {
    this.now = options.now ?? Date.now;
    this.authRate = createAuthRateLimiter(this.now, { strict: true });
    this.origins = new Set([auth.issuer, ...(options.browserOrigins ?? []).map(mcpIssuer)]);
  }

  static async open(options: ExternalMcpHttpOptions): Promise<ExternalMcpHttp> {
    if ((options.browserOrigins?.length ?? 0) > 8) throw new McpOAuthError("invalid_request");
    for (const origin of options.browserOrigins ?? []) mcpIssuer(origin);
    const auth = await ExternalMcpAuthorization.open({
      storePath: join(options.userData, "external-mcp-grants.json"), issuer: options.issuer, now: options.now,
      revoked: (grantId) => { void options.threads?.revoked(grantId); },
    });
    return new ExternalMcpHttp(options, auth);
  }

  private prune(): void {
    for (const [id, request] of this.consents) if (request.expiresAt <= this.now()) this.consents.delete(id);
    for (const [id, rate] of this.calls) if (rate.until <= this.now()) this.calls.delete(id);
  }

  /** Local owner only, including reads. Public pages have no management route. */
  async manage(input: unknown, principal: HostInvocationPrincipal): Promise<unknown> {
    if (!isHostOwner(principal)) throw ownerRefusal();
    const next = this.management.catch(() => undefined).then(() => this.manageOwned(input));
    this.management = next;
    return next;
  }

  private async manageOwned(input: unknown): Promise<unknown> {
    if (this.closed) throw new McpOAuthError("temporarily_unavailable");
    this.prune();
    const args = object(input);
    const action = string(args.action);
    const keys: Record<string, readonly string[]> = { status: [], register: ["name", "redirectUris"], approve: ["requestId", "projectIds", "scope", "execution"], deny: ["requestId"], revoke: ["grantId"], remove: ["clientId"] };
    if (!Object.hasOwn(keys, action) || Object.keys(args).some((key) => key !== "action" && !keys[action]!.includes(key))) throw new McpOAuthError("invalid_request");
    if (action === "status") {
      const host = await this.options.host();
      return { issuer: this.auth.issuer, resource: this.auth.resource, proxyUrl: this.options.proxyUrl?.(), scopes: this.scopes(), protocolVersion: "2025-11-25", ...this.auth.ownerState(), projects: host.threadIndexSnapshot().projects.filter((project) => project.workspaceId).map((project) => ({ id: project.workspaceId, name: project.name })) };
    }
    if (action === "register") return this.auth.registerClient({ name: string(args.name, 80), redirectUris: strings(args.redirectUris, 8) });
    if (action === "approve") {
      const requestId = string(args.requestId);
      const consent = this.consents.get(requestId);
      if (!consent || consent.denied || consent.redirect) throw new McpOAuthError("invalid_request");
      const projectIds = strings(args.projectIds, 64);
      const host = await this.options.host();
      const known = new Set(host.threadIndexSnapshot().projects.map((project) => project.workspaceId));
      if (projectIds.some((id) => !known.has(id))) throw new McpOAuthError("invalid_request");
      // Control is an explicit owner choice: the requested scope is never granted by default, and `full` only when named.
      const scope: ExternalMcpScope[] = args.scope === undefined ? ["tau:read"] : this.scope(string(args.scope, 64));
      if (args.execution !== undefined && (!scope.includes("tau:threads") || !isExternalMcpExecution(args.execution))) throw new McpOAuthError("invalid_request");
      const result = await this.auth.approve(requestId, { projectIds, scope: scope.join(" "), execution: scope.includes("tau:threads") ? (args.execution as ExternalMcpExecution | undefined) ?? "ask" : "read-only" });
      consent.redirect = result.redirectUri;
      consent.expiresAt = this.now() + REQUEST_LIFETIME;
      return { approved: true };
    }
    if (action === "deny") {
      const requestId = string(args.requestId);
      const consent = this.consents.get(requestId);
      if (!consent || consent.redirect) throw new McpOAuthError("invalid_request");
      await this.auth.deny(requestId);
      if (consent) { consent.denied = true; delete consent.redirect; }
      return { denied: true };
    }
    if (action === "revoke") { await this.auth.revokeGrant(string(args.grantId)); return { revoked: true }; }
    const clientId = string(args.clientId);
    await this.auth.removeClient(clientId);
    for (const [id, consent] of this.consents) if (consent.clientId === clientId) this.consents.delete(id);
    return { removed: true };
  }

  private scopes(): ExternalMcpScope[] { return this.options.threads ? ["tau:read", "tau:threads"] : ["tau:read"]; }

  /** A scope string this resource offers; `tau:threads` only where control is wired. */
  private scope(value: string): ExternalMcpScope[] {
    const scopes = mcpScopes(value);
    if (scopes.some((scope) => !this.scopes().includes(scope))) throw new McpOAuthError("invalid_scope");
    return scopes;
  }

  /** True means this route owns the response; false lets static/socket HTTP fall through. */
  async handle(request: IncomingMessage, response: ServerResponse, trust: ListenerTrust): Promise<boolean> {
    let url: URL;
    try { url = new URL(request.url ?? "/", this.auth.issuer); } catch { return false; }
    if (!PATHS.has(url.pathname)) return false;
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    this.prune();
    try {
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i]!.toLowerCase();
        if (!["host", "origin", "authorization", "content-type", "mcp-protocol-version"].includes(key)) continue;
        if (seen.has(key)) throw new McpOAuthError("invalid_request");
        seen.add(key);
      }
      if (this.closed || this.responses.size >= 32) { reply(response, 503, { error: "temporarily_unavailable" }); return true; }
      if ((request.url?.length ?? 0) > 8192) throw new McpOAuthError("invalid_request");
      if (url.origin !== this.auth.issuer || request.headers.host !== new URL(this.auth.issuer).host
        || (!(request.socket as TLSSocket).encrypted && trust !== "proxy")) { reply(response, 403, { error: "forbidden_host" }); return true; }
      const origin = request.headers.origin;
      if (origin && !this.origins.has(origin)) { reply(response, 403, { error: "forbidden_origin" }); return true; }
      if (origin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-expose-headers", "WWW-Authenticate, MCP-Protocol-Version");
      }
      this.responses.add(response);
      const timeout = setTimeout(() => response.destroy(), 60_000);
      timeout.unref();
      const done = () => { clearTimeout(timeout); this.responses.delete(response); };
      response.once("finish", done);
      response.once("close", done);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version", "access-control-max-age": "600" });
        response.end();
        return true;
      }
      if (url.pathname === "/mcp") { await this.mcp(request, response, url); return true; }
      if (["/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(url.pathname)) {
        const wait = this.authRate(request.socket.remoteAddress);
        if (wait) { response.setHeader("retry-after", String(Math.ceil(wait / 1000))); reply(response, 429, { error: "temporarily_unavailable" }); return true; }
      }
      if (url.pathname === "/oauth/token" || url.pathname === "/oauth/revoke") await this.token(request, response, url);
      else {
        if (request.method !== "GET") { response.setHeader("allow", "GET"); reply(response, 405, { error: "invalid_request" }); return true; }
        if (url.pathname === "/oauth/authorize") this.authorize(response, url);
        else if (url.pathname === "/oauth/consent") this.consent(response, url);
        else this.metadata(response, url);
      }
    } catch (error) {
      reply(response, error instanceof McpOAuthError && error.code === "temporarily_unavailable" ? 503 : 400, { error: error instanceof McpOAuthError ? error.code : "invalid_request" });
    }
    return true;
  }

  private metadata(response: ServerResponse, url: URL): void {
    if (url.search) throw new McpOAuthError("invalid_request");
    const issuer = this.auth.issuer;
    if (url.pathname === "/.well-known/oauth-authorization-server") reply(response, 200, {
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: this.scopes(), authorization_response_iss_parameter_supported: true,
    });
    else reply(response, 200, { resource: this.auth.resource, authorization_servers: [issuer], scopes_supported: this.scopes(), bearer_methods_supported: ["header"] });
  }

  private authorize(response: ServerResponse, url: URL): void {
    const params = parameters(url.searchParams, ["response_type", "client_id", "redirect_uri", "resource", "scope", "code_challenge", "code_challenge_method", "state"]);
    if (params.response_type !== "code") throw new McpOAuthError("invalid_request");
    if (params.scope !== undefined) this.scope(params.scope);
    if (this.consents.size >= MAX_CONSENTS) throw new McpOAuthError("temporarily_unavailable");
    const id = this.auth.requestAuthorization({ clientId: string(params.client_id), redirectUri: string(params.redirect_uri, 2048), resource: string(params.resource, 2048), scope: params.scope, codeChallenge: string(params.code_challenge, 43), codeChallengeMethod: string(params.code_challenge_method), state: params.state });
    const denial = new URL(params.redirect_uri!);
    denial.searchParams.set("error", "access_denied");
    denial.searchParams.set("iss", this.auth.issuer);
    if (params.state !== undefined) denial.searchParams.set("state", params.state);
    this.consents.set(id, { clientId: params.client_id!, expiresAt: this.now() + REQUEST_LIFETIME, denialRedirect: denial.href });
    response.writeHead(303, { location: `/oauth/consent?request_id=${encodeURIComponent(id)}` });
    response.end();
  }

  private consent(response: ServerResponse, url: URL): void {
    const params = parameters(url.searchParams, ["request_id"]);
    const id = string(params.request_id);
    const consent = this.consents.get(id);
    if (!consent) { reply(response, 410, { error: "expired_request" }); return; }
    if (consent.denied) { response.writeHead(303, { location: consent.denialRedirect }); response.end(); return; }
    if (consent.redirect) { response.writeHead(303, { location: consent.redirect }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", refresh: `2;url=/oauth/consent?request_id=${encodeURIComponent(id)}` });
    response.end("<!doctype html><html lang=en><meta charset=utf-8><title>Allow access in Tau</title><h1>Waiting for the machine's owner</h1><p>The owner must approve this client's access, choose its projects and, for thread control, its execution ceiling in Tau's command line. This page refreshes automatically. You may close it to cancel signing in.</html>");
  }

  private async token(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "POST") { response.setHeader("allow", "POST"); reply(response, 405, { error: "invalid_request" }); return; }
    if (url.search || request.headers.authorization || request.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") throw new McpOAuthError("invalid_request");
    const params = parameters(new URLSearchParams(await readBody(request)), ["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "resource", "refresh_token", "scope", "token", "token_type_hint"]);
    const clientId = string(params.client_id);
    if (url.pathname === "/oauth/revoke") { await this.auth.revokeToken(clientId, string(params.token)); reply(response, 200, {}); return; }
    const resource = string(params.resource, 2048);
    if (params.scope !== undefined) this.scope(params.scope);
    const result = params.grant_type === "authorization_code"
      ? await this.auth.exchangeCode({ clientId, resource, code: string(params.code), codeVerifier: string(params.code_verifier), redirectUri: string(params.redirect_uri, 2048) })
      : params.grant_type === "refresh_token" ? await this.auth.refresh({ clientId, resource, refreshToken: string(params.refresh_token), scope: params.scope }) : undefined;
    if (!result) throw new McpOAuthError("invalid_request");
    reply(response, 200, result);
  }

  private async mcp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.search) throw new McpOAuthError("invalid_request");
    const token = /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? "")?.[1];
    const grant = token && this.auth.authenticate(token, this.auth.resource);
    if (!grant) {
      response.setHeader("www-authenticate", `Bearer resource_metadata="${this.auth.issuer}/.well-known/oauth-protected-resource/mcp", scope="tau:read"`);
      reply(response, 401, { error: "invalid_token" });
      return;
    }
    const rate = this.calls.get(grant.id) ?? { until: this.now() + 60_000, count: 0 };
    if (rate.count >= 120 || (!this.calls.has(grant.id) && this.calls.size >= 128)) { reply(response, 429, { error: "temporarily_unavailable" }); return; }
    rate.count++;
    this.calls.set(grant.id, rate);
    if (request.method !== "POST") { response.setHeader("allow", "POST"); reply(response, 405, { error: "method_not_allowed" }); return; }
    if (request.headers["mcp-protocol-version"] && request.headers["mcp-protocol-version"] !== "2025-11-25") throw new McpOAuthError("invalid_request");
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new McpOAuthError("invalid_request");
    // This wire version permits exactly one JSON-RPC message per HTTP POST.
    // The SDK also accepts older batched versions, so reject them before it.
    const body = object(JSON.parse(await readBody(request)));
    if (body.method === "initialize") {
      if (object(body.params).protocolVersion !== "2025-11-25") throw new McpOAuthError("invalid_request");
    } else if (request.headers["mcp-protocol-version"] !== "2025-11-25") throw new McpOAuthError("invalid_request");
    await serveExternalMcp({ auth: this.auth, token: token!, host: () => this.options.host(), ...(this.options.threads ? { threads: this.options.threads } : {}), version: this.options.version, reads: this.reads, ...(this.options.log ? { log: this.options.log } : {}) }, request, response, body);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const response of this.responses) response.destroy();
    this.responses.clear();
    this.consents.clear();
    await this.auth.close();
  }
}
