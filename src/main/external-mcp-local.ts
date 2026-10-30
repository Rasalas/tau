import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { UiLocalMcpStatus } from "../shared/external-mcp.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { ExternalMcpControlHost } from "./external-mcp-control-tools.js";
import { ExternalMcpAuthorization, LOCAL_MCP_ISSUER, NEVER_EXPIRES, type LocalMcpToken } from "./external-mcp-authorization.js";
import { McpOAuthError, isExternalMcpExecution, type ExternalMcpScope } from "./external-mcp-policy.js";
import { serveExternalMcp } from "./external-mcp-serve.js";
import type { ExternalMcpThreads } from "./external-mcp-threads.js";
import { isHostOwner, type HostInvocationPrincipal } from "./host-invocation.js";
import { ownerRefusal } from "./host-method-access.js";
import { createAuthRateLimiter } from "./host-rate-limit.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const LOOPBACK = "127.0.0.1";
const BODY_LIMIT = 64 * 1024;
const MAX_RESPONSES = 32;
const DAY = 24 * 60 * 60_000;
const Settings = Type.Object({
  version: Type.Literal(1), enabled: Type.Boolean(),
  port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
}, { additionalProperties: false });
type ListenerSettings = { enabled: boolean; port?: number };

export interface ExternalMcpLocalOptions {
  userData: string;
  version: string;
  host(): Promise<ExternalMcpControlHost>;
  threads: ExternalMcpThreads;
  now?: () => number;
  logger?: PersistedJsonLogger;
  log?(label: string, detail?: string): void;
}

/** What the owner's Settings page shows; never a token or its hash. */
export type LocalMcpStatus = UiLocalMcpStatus;

function reply(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpOAuthError("invalid_request");
  return value as Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<string> {
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

/**
 * Local MCP clients on this machine (ADR 0046): a loopback-only listener with
 * owner-issued bearer tokens, the same tools and grant checks as the HTTPS
 * resource. Off until the owner enables it or creates the first token; its
 * port is kept so a client's configuration survives restarts.
 */
export class ExternalMcpLocal {
  private readonly now: () => number;
  private readonly authRate: (source: string | undefined) => number;
  private readonly calls = new Map<string, { until: number; count: number }>();
  private readonly responses = new Set<ServerResponse>();
  private readonly reads = new Set<Promise<unknown>>();
  private server?: Server;
  private problem?: string;
  private management: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(private readonly options: ExternalMcpLocalOptions, private readonly auth: ExternalMcpAuthorization, private settings: ListenerSettings | undefined) {
    this.now = options.now ?? Date.now;
    this.authRate = createAuthRateLimiter(this.now, { strict: true });
  }

  static async open(options: ExternalMcpLocalOptions): Promise<ExternalMcpLocal> {
    const auth = await ExternalMcpAuthorization.open({
      storePath: join(options.userData, "external-mcp-local-tokens.json"), issuer: LOCAL_MCP_ISSUER, now: options.now, logger: options.logger,
      revoked: (grantId) => { void options.threads.revoked(grantId); },
    });
    try {
      const read = await readPersistedJson(join(options.userData, "external-mcp-local.json"), {
        expectedVersion: 1, logger: options.logger,
        decode: (value) => Check(Settings, value) ? { enabled: value.enabled, ...(value.port ? { port: value.port } : {}) } : undefined,
      });
      const local = new ExternalMcpLocal(options, auth, read?.data);
      if (local.settings?.enabled) await local.listen();
      return local;
    } catch (error) { await auth.close(); throw error; }
  }

  /** Where clients connect while the listener is open. */
  url(): string | undefined {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    return port ? `http://${LOOPBACK}:${port}/mcp` : undefined;
  }

  /** Local owner only, like every other connection management. */
  manage(input: unknown, principal: HostInvocationPrincipal): Promise<unknown> {
    if (!isHostOwner(principal)) return Promise.reject(ownerRefusal());
    const next = this.management.catch(() => undefined).then(() => this.manageOwned(input));
    this.management = next;
    return next;
  }

  private async manageOwned(input: unknown): Promise<unknown> {
    if (this.closed) throw new McpOAuthError("temporarily_unavailable");
    const args = object(input);
    const keys: Record<string, readonly string[]> = {
      "local-status": [], "local-create": ["name", "projectIds", "control", "execution", "expiresInDays"],
      "local-revoke": ["id"], "local-enable": ["port"], "local-disable": [],
    };
    const action = typeof args.action === "string" ? args.action : "";
    if (!Object.hasOwn(keys, action) || Object.keys(args).some((key) => key !== "action" && !keys[action]!.includes(key))) throw new McpOAuthError("invalid_request");
    if (action === "local-create") {
      if (typeof args.name !== "string" || !Array.isArray(args.projectIds) || args.projectIds.some((id) => typeof id !== "string")
        || (args.control !== undefined && typeof args.control !== "boolean") || (args.execution !== undefined && (!args.control || !isExternalMcpExecution(args.execution)))
        || (args.expiresInDays !== undefined && args.expiresInDays !== null && (!Number.isSafeInteger(args.expiresInDays) || (args.expiresInDays as number) < 1 || (args.expiresInDays as number) > 3650))) throw new McpOAuthError("invalid_request");
      const known = new Set((await this.options.host()).threadIndexSnapshot().projects.filter((project) => !project.projectless).map((project) => project.workspaceId));
      if (!args.projectIds.length || args.projectIds.some((id) => !known.has(id as string))) throw new McpOAuthError("invalid_request");
      const scopes: ExternalMcpScope[] = args.control ? ["tau:read", "tau:threads"] : ["tau:read"];
      const created = await this.auth.createLocalToken({
        name: args.name.trim(), projectIds: args.projectIds as string[], scopes,
        // Control defaults to asking; `full` only when the owner names it.
        ...(args.control ? { execution: (args.execution as LocalMcpToken["execution"] | undefined) ?? "ask" } : {}),
        ...(typeof args.expiresInDays === "number" ? { expiresAt: this.now() + args.expiresInDays * DAY } : {}),
      });
      // The first token opens the listener unless the owner turned it off before.
      if (this.settings === undefined) await this.configure({ enabled: true });
      return { token: created.token, id: created.grant.id, ...(this.url() ? { url: this.url() } : {}) };
    }
    if (action === "local-revoke") {
      if (typeof args.id !== "string" || !this.auth.localTokens().some((token) => token.id === args.id)) throw new McpOAuthError("invalid_request");
      await this.auth.revokeGrant(args.id);
      return { revoked: true };
    }
    if (action === "local-enable") {
      if (args.port !== undefined && (!Number.isSafeInteger(args.port) || (args.port as number) < 1024 || (args.port as number) > 65535)) throw new McpOAuthError("invalid_request");
      await this.configure({ enabled: true, ...(args.port !== undefined ? { port: args.port as number } : this.settings?.port ? { port: this.settings.port } : {}) });
    } else if (action === "local-disable") await this.configure({ enabled: false, ...(this.settings?.port ? { port: this.settings.port } : {}) });
    return this.status();
  }

  private async status(): Promise<LocalMcpStatus> {
    const host = await this.options.host();
    return {
      enabled: this.settings?.enabled === true, listening: Boolean(this.server),
      ...(this.url() ? { url: this.url() } : {}), ...(this.settings?.port ? { port: this.settings.port } : {}), ...(this.problem ? { problem: this.problem } : {}),
      protocolVersion: "2025-11-25",
      tokens: this.auth.localTokens().map(({ clientId: _clientId, expiresAt, ...token }) => ({ ...token, scopes: [...token.scopes], projectIds: [...token.projectIds], ...(expiresAt === NEVER_EXPIRES ? {} : { expiresAt }) })),
      projects: host.threadIndexSnapshot().projects.filter((project) => project.workspaceId && !project.projectless).map((project) => ({ id: project.workspaceId!, name: project.name })),
    };
  }

  private async configure(next: ListenerSettings): Promise<void> {
    const moved = next.port !== undefined && next.port !== (this.server?.address() as AddressInfo | null)?.port;
    if (!next.enabled || moved) await this.stop();
    this.settings = next;
    if (next.enabled && !this.server) await this.listen();
    await writePersistedJson(join(this.options.userData, "external-mcp-local.json"), 1, { ...this.settings }, { logger: this.options.logger });
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => { void this.handle(request, response).catch(() => reply(response, 500, { error: "internal_error" })); });
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.settings?.port ?? 0, LOOPBACK, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      // A taken port stays configured: clients keep their address, and the owner chooses another.
      this.problem = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${this.settings?.port} is in use by another program.` : "The local listener could not start.";
      this.options.log?.("external-mcp.local-listen-failed", String(error));
      return;
    }
    this.problem = undefined;
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    if (this.settings && this.settings.port !== port) {
      this.settings = { ...this.settings, port };
      await writePersistedJson(join(this.options.userData, "external-mcp-local.json"), 1, { ...this.settings }, { logger: this.options.logger });
    }
    this.options.log?.("external-mcp.local-listening", `${LOOPBACK}:${port}`);
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const response of this.responses) response.destroy();
    this.responses.clear();
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  /** Exported for tests: the listener's request handler. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const port = (this.server?.address() as AddressInfo | null)?.port;
    let path: string;
    try { path = new URL(request.url ?? "/", `http://${LOOPBACK}`).pathname; } catch { reply(response, 400, { error: "invalid_request" }); return; }
    if (path !== "/mcp") { reply(response, 404, { error: "not_found" }); return; }
    try {
      const seen = new Set<string>();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const key = request.rawHeaders[i]!.toLowerCase();
        if (!["host", "origin", "authorization", "content-type", "mcp-protocol-version"].includes(key)) continue;
        if (seen.has(key)) throw new McpOAuthError("invalid_request");
        seen.add(key);
      }
      // A page in a browser can reach a loopback port; a rebound name or any Origin is never a local client.
      const host = request.headers.host ?? "";
      if (!port || (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`)) { reply(response, 403, { error: "forbidden_host" }); return; }
      if (request.headers.origin !== undefined) { reply(response, 403, { error: "forbidden_origin" }); return; }
      if (this.closed || this.responses.size >= MAX_RESPONSES) { reply(response, 503, { error: "temporarily_unavailable" }); return; }
      if ((request.url?.length ?? 0) > 2048 || new URL(request.url ?? "/", `http://${LOOPBACK}`).search) throw new McpOAuthError("invalid_request");
      this.responses.add(response);
      const timeout = setTimeout(() => response.destroy(), 60_000);
      timeout.unref();
      const done = () => { clearTimeout(timeout); this.responses.delete(response); };
      response.once("finish", done);
      response.once("close", done);
      const token = /^Bearer (\S+)$/iu.exec(request.headers.authorization ?? "")?.[1];
      const grant = token && this.auth.authenticate(token, this.auth.resource);
      if (!grant) {
        // Only failures count, so a working client is never slowed by its own calls.
        const wait = this.authRate(request.socket.remoteAddress);
        if (wait) reply(response, 429, { error: "temporarily_unavailable" }, { "retry-after": String(Math.ceil(wait / 1000)) });
        else reply(response, 401, { error: "invalid_token", message: "A Tau local MCP token is required. Create one in Settings → Connections." }, { "www-authenticate": "Bearer" });
        return;
      }
      for (const [id, rate] of this.calls) if (rate.until <= this.now()) this.calls.delete(id);
      const rate = this.calls.get(grant.id) ?? { until: this.now() + 60_000, count: 0 };
      if (rate.count >= 120 || (!this.calls.has(grant.id) && this.calls.size >= 128)) { reply(response, 429, { error: "temporarily_unavailable" }); return; }
      rate.count++;
      this.calls.set(grant.id, rate);
      // Stateless: nothing to resume and no server-initiated stream.
      if (request.method !== "POST") { reply(response, 405, { error: "method_not_allowed" }, { allow: "POST" }); return; }
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new McpOAuthError("invalid_request");
      // One JSON-RPC message per POST; the SDK negotiates the protocol version.
      let body: Record<string, unknown>;
      try { body = object(JSON.parse(await readBody(request))); } catch { throw new McpOAuthError("invalid_request"); }
      await serveExternalMcp({ auth: this.auth, token: token!, host: () => this.options.host(), threads: this.options.threads, version: this.options.version, reads: this.reads, ...(this.options.log ? { log: this.options.log } : {}) }, request, response, body);
    } catch (error) {
      reply(response, error instanceof McpOAuthError && error.code === "temporarily_unavailable" ? 503 : 400, { error: error instanceof McpOAuthError ? error.code : "invalid_request" });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    await this.auth.close();
  }
}

/**
 * The owner's `external-mcp-manage`: `local-*` actions manage local tokens and
 * the loopback listener; the others the HTTPS OAuth resource, when configured.
 */
export function routeExternalMcpManage(local: () => Pick<ExternalMcpLocal, "manage"> | undefined, oauth: () => { manage(input: unknown, principal: HostInvocationPrincipal): Promise<unknown> } | undefined) {
  return {
    manage(input: unknown, principal: HostInvocationPrincipal): Promise<unknown> {
      if (!isHostOwner(principal)) return Promise.reject(ownerRefusal());
      const action = input && typeof input === "object" ? (input as { action?: unknown }).action : undefined;
      const target = typeof action === "string" && action.startsWith("local-") ? local() : oauth();
      if (!target) {
        return Promise.reject(Object.assign(new Error(typeof action === "string" && action.startsWith("local-")
          ? "Local MCP clients are unavailable in this Tau." : "Set TAU_MCP_ORIGIN to this machine's HTTPS origin before starting Tau."), { code: HOST_ERROR.unsupported }));
      }
      return target.manage(input, principal);
    },
  };
}
