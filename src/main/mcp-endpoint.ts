import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type {
  HostMcpConnection,
  HostMcpTool,
  HostMcpToolGate,
  HostMcpToolProvider,
  RuntimeSessionInfo,
} from "./host-extensions.js";

/** The server name every runtime puts in front of Tau's tools. */
export const MCP_SERVER_NAME = "tau";
const MCP_PATH = "/mcp";
const LOOPBACK = "127.0.0.1";
const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export interface McpEndpointOptions {
  providers(): Iterable<HostMcpToolProvider>;
  gates(): Iterable<HostMcpToolGate>;
  /** A yes/no question on the thread's dialog surface; a cancelled one is `false`. */
  confirm(threadId: string, title: string, message: string, signal: AbortSignal): Promise<boolean>;
  log(label: string, detail?: string): void;
  version?: string;
}

interface Credential {
  readonly token: string;
  readonly hash: string;
  thread: RuntimeSessionInfo;
}

/** What a tools/call answers, in MCP's shape. */
export interface McpCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const failure = (text: string): McpCallResult => ({ content: [{ type: "text", text }], isError: true });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The host's MCP endpoint (ADR 0022): Streamable HTTP on 127.0.0.1, stateless,
 * one bearer credential per thread. The credential decides the thread, so a
 * runtime only ever sees the tools of the thread it was started for.
 */
export class McpEndpoint {
  private listening?: Promise<number>;
  private http?: HttpServer;
  private readonly credentials = new Map<string, Credential>();
  private readonly threads = new Map<string, Credential>();
  /** Calls in flight per thread; revoking the thread aborts them. */
  private readonly calls = new Map<string, Set<AbortController>>();
  /** Tools that must run one at a time, chained per thread. */
  private readonly sequential = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: McpEndpointOptions) {}

  async connect(thread: RuntimeSessionInfo): Promise<HostMcpConnection | undefined> {
    if (this.closed || !thread.sessionId) return undefined;
    let port: number;
    try {
      port = await this.listen();
    } catch (error) {
      this.options.log("mcp.listen-failed", messageOf(error));
      return undefined;
    }
    let credential = this.threads.get(thread.sessionId);
    if (credential) credential.thread = { sessionId: thread.sessionId, cwd: thread.cwd };
    else {
      const token = randomBytes(32).toString("base64url");
      credential = { token, hash: hashOf(token), thread: { sessionId: thread.sessionId, cwd: thread.cwd } };
      this.credentials.set(credential.hash, credential);
      this.threads.set(thread.sessionId, credential);
    }
    return {
      name: MCP_SERVER_NAME,
      url: `http://${LOOPBACK}:${port}${MCP_PATH}`,
      token: credential.token,
      headers: { Authorization: `Bearer ${credential.token}` },
    };
  }

  /** The thread's runtime closed: its credential stops working and its calls are cancelled. */
  revoke(threadId: string): void {
    const credential = this.threads.get(threadId);
    if (credential) {
      this.threads.delete(threadId);
      this.credentials.delete(credential.hash);
    }
    for (const controller of this.calls.get(threadId) ?? []) controller.abort(new Error("The thread's runtime closed."));
    this.calls.delete(threadId);
    this.sequential.delete(threadId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const threadId of [...this.threads.keys(), ...this.calls.keys()]) this.revoke(threadId);
    const http = this.http;
    this.http = undefined;
    this.listening = undefined;
    if (http) await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); });
  }

  /** The tools a thread is offered: every provider's, the first of a name wins. */
  tools(thread: RuntimeSessionInfo): HostMcpTool[] {
    const byName = new Map<string, HostMcpTool>();
    for (const provider of this.options.providers()) {
      let tools: readonly HostMcpTool[];
      try {
        tools = provider(thread);
      } catch (error) {
        this.options.log("mcp.tools-failed", messageOf(error));
        continue;
      }
      for (const tool of tools) if (!byName.has(tool.name)) byName.set(tool.name, tool);
    }
    return [...byName.values()];
  }

  /** One tools/call for the thread a credential names: validate, gate, run. */
  async call(thread: RuntimeSessionInfo, name: string, input: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const tool = this.tools(thread).find((candidate) => candidate.name === name);
    if (!tool) return failure(`Tau has no tool "${name}" for this thread.`);
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    signal?.addEventListener("abort", forward, { once: true });
    const running = this.calls.get(thread.sessionId) ?? new Set<AbortController>();
    this.calls.set(thread.sessionId, running);
    running.add(controller);
    try {
      let args: Record<string, unknown>;
      try {
        const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const prepared = tool.prepareArguments ? tool.prepareArguments(raw) as Record<string, unknown> : raw;
        args = validateToolArguments(tool, { type: "toolCall", id: randomUUID(), name, arguments: prepared }) as Record<string, unknown>;
      } catch (error) {
        return failure(messageOf(error));
      }
      const refusal = await this.gate(thread, name, args, controller.signal);
      if (refusal) return failure(refusal);
      const run = () => this.execute(tool, args, controller.signal);
      return tool.executionMode === "sequential" ? await this.inSequence(thread.sessionId, run) : await run();
    } finally {
      signal?.removeEventListener("abort", forward);
      running.delete(controller);
      if (running.size === 0 && this.calls.get(thread.sessionId) === running) this.calls.delete(thread.sessionId);
    }
  }

  /** The first gate that blocks names the reason; a gate that fails blocks too. */
  private async gate(thread: RuntimeSessionInfo, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string | undefined> {
    for (const gate of [...this.options.gates()]) {
      try {
        const verdict = await gate({
          threadId: thread.sessionId,
          cwd: thread.cwd,
          toolName,
          input,
          signal,
          confirm: (title, message) => this.options.confirm(thread.sessionId, title, message, signal),
        });
        if (verdict?.block) {
          this.options.log("mcp.blocked", `${toolName}: ${verdict.reason}`);
          return verdict.reason;
        }
      } catch (error) {
        this.options.log("mcp.gate-failed", `${toolName}: ${messageOf(error)}`);
        return `Blocked by Tau: the check before ${toolName} failed (${messageOf(error)}).`;
      }
    }
    return undefined;
  }

  private async execute(tool: HostMcpTool, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    if (signal.aborted) return failure(`${tool.name} was cancelled.`);
    try {
      const result = await tool.execute(randomUUID(), args, signal, undefined, undefined as never) as { content: unknown[]; isError?: boolean };
      const content = result.content.flatMap((part): McpCallResult["content"] => {
        const block = part as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };
        if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
        if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
        return [];
      });
      return { content, ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      return failure(messageOf(error));
    }
  }

  private inSequence<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sequential.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.sequential.set(threadId, settled);
    void settled.then(() => { if (this.sequential.get(threadId) === settled) this.sequential.delete(threadId); });
    return next;
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const http = createServer((request, response) => { void this.handle(request, response); });
      http.once("error", (error) => { this.listening = undefined; reject(error); });
      http.listen(0, LOOPBACK, () => {
        http.unref();
        this.http = http;
        this.options.log("mcp.listening", `${LOOPBACK}:${(http.address() as AddressInfo).port}`);
        resolve((http.address() as AddressInfo).port);
      });
    });
    return this.listening;
  }

  private credentialFor(request: IncomingMessage): Credential | undefined {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
    return match ? this.credentials.get(hashOf(match[1]!)) : undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = (this.http?.address() as AddressInfo | null)?.port;
    const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      if (response.headersSent) return;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? "/", `http://${LOOPBACK}`).pathname;
    if (path !== MCP_PATH) return reply(404, { error: "not_found" });
    // A page in a browser could reach a loopback port; a rebound name or an Origin is never a runtime.
    const host = request.headers.host ?? "";
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return reply(403, { error: "forbidden_host" });
    if (request.headers.origin) return reply(403, { error: "forbidden_origin" });
    const credential = this.credentialFor(request);
    if (!credential) {
      this.options.log("mcp.unauthorized", request.headers.authorization ? "unknown or revoked credential" : "no credential");
      return reply(401, { error: "invalid_credential", message: "A thread-bound Tau MCP credential is required." }, { "www-authenticate": "Bearer" });
    }
    // Stateless: nothing to resume, no server-initiated stream.
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, { allow: "POST" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      return reply(400, { error: "bad_request", message: messageOf(error) });
    }
    try {
      await this.serve(credential, request, response, body);
    } catch (error) {
      this.options.log("mcp.request-failed", messageOf(error));
      reply(500, { error: "internal_error" });
    }
  }

  /** One request, one server: a stateless transport keeps nothing between them. */
  private async serve(credential: Credential, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    const server = new Server({ name: MCP_SERVER_NAME, title: "Tau", version: this.options.version ?? "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools(credential.thread).map((tool) => ({
        name: tool.name,
        ...(tool.label && tool.label !== tool.name ? { title: tool.label } : {}),
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as { type: "object"; [key: string]: unknown },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (call, extra) =>
      this.call(credential.thread, call.params.name, call.params.arguments, extra.signal));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error("The request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
