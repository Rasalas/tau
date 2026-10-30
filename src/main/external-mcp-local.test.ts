import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ThreadIndexSnapshot } from "../shared/contracts.js";
import type { ExternalMcpControlHost } from "./external-mcp-control-tools.js";
import { ExternalMcpLocal, routeExternalMcpManage, type LocalMcpStatus } from "./external-mcp-local.js";
import { ExternalMcpThreads } from "./external-mcp-threads.js";
import { HOST_CORE_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const index: ThreadIndexSnapshot = {
  projects: [{ name: "Project a", workspaceId: "a", path: "/private/a", lastOpenedAt: 1 }, { name: "Project b", workspaceId: "b", path: "/private/b", lastOpenedAt: 1 }],
  sessions: [{ id: "thread-a", title: "Allowed", workspaceId: "a", projectPath: "/private/a", projectName: "a", path: "/private/s", modifiedAt: 1, messageCount: 1 }],
  complete: true,
};

async function fixture(userData?: string) {
  const dir = userData ?? await mkdtemp(join(tmpdir(), "tau-mcp-local-"));
  if (!userData) cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const host = { resolveWorkspacePath: (id: string) => `/private/${id}`, startThread: vi.fn(async () => { throw new Error("unset"); }), threadIndexSnapshot: () => index, loadTranscript: vi.fn(async (sessionId: string) => ({ sessionId, hasMore: false, messages: [{ id: "m", role: "user" as const, text: "Hello", timestamp: 1 }] })) } as unknown as ExternalMcpControlHost;
  const threads = await ExternalMcpThreads.open({ path: join(dir, "external-mcp-threads.json") });
  const local = await ExternalMcpLocal.open({ userData: dir, version: "test", host: async () => host, threads });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await local.close(); } };
  cleanup.push(close);
  const manage = (input: Record<string, unknown>, principal: HostInvocationPrincipal = HOST_CORE_PRINCIPAL) => local.manage(input, principal);
  const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, port = Number(new URL(local.url()!).port)) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: init.method ?? "POST", headers: { host: `127.0.0.1:${port}`, ...init.headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(init.body);
  });
  const sdk = async (token: string) => {
    const client = new Client({ name: "fixture", version: "1" });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(local.url()!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  };
  return { dir, local, host, manage, send, sdk, close };
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "curl", version: "1" } } });

describe("local MCP clients", () => {
  it("stays off until the owner creates the first token, then listens on loopback only", async () => {
    const f = await fixture();
    expect(f.local.url()).toBeUndefined();
    expect(await f.manage({ action: "local-status" })).toMatchObject({ enabled: false, listening: false, tokens: [] });
    const created = await f.manage({ action: "local-create", name: "Claude Code", projectIds: ["a"], control: true }) as { token: string; id: string; url: string };
    expect(created.token).toMatch(/^tau_mcp_local_/u);
    expect(created.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    const status = await f.manage({ action: "local-status" }) as LocalMcpStatus;
    expect(status).toMatchObject({ enabled: true, listening: true, url: created.url, tokens: [{ id: created.id, name: "Claude Code", scopes: ["tau:read", "tau:threads"], execution: "ask", projectIds: ["a"] }] });
    expect(status.tokens[0]).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(status)).not.toContain(created.token);
    const disk = await readFile(join(f.dir, "external-mcp-local-tokens.json"), "utf8");
    expect(disk).not.toContain(created.token);
  });

  it("defaults control to ask, takes full only when named, and refuses unknown projects", async () => {
    const f = await fixture();
    await expect(f.manage({ action: "local-create", name: "x", projectIds: ["/etc"] })).rejects.toThrow("invalid_request");
    await expect(f.manage({ action: "local-create", name: "x", projectIds: ["a"], execution: "full" })).rejects.toThrow("invalid_request");
    await f.manage({ action: "local-create", name: "read", projectIds: ["a"] });
    await f.manage({ action: "local-create", name: "full", projectIds: ["a", "b"], control: true, execution: "full", expiresInDays: 30 });
    const { tokens } = await f.manage({ action: "local-status" }) as LocalMcpStatus;
    expect(tokens.map((token) => [token.name, token.execution, token.scopes.length, token.expiresAt !== undefined])).toEqual([["full", "full", 2, true], ["read", "read-only", 1, false]]);
  });

  it.each<HostInvocationPrincipal>([
    { kind: "workbench-client", connection: "remote" },
    { kind: "workbench-client", connection: "paired", local: true, pairedClient: "device" },
    { kind: "host-extension", contextId: "extension" },
  ])("refuses management by a non-owner %j", async (principal) => {
    const f = await fixture();
    for (const action of ["local-status", "local-create", "local-enable", "local-disable", "local-revoke"]) {
      await expect(f.manage({ action }, principal)).rejects.toThrow("Only a connection");
    }
    const router = routeExternalMcpManage(() => f.local, () => undefined);
    await expect(router.manage({ action: "local-status" }, principal)).rejects.toThrow("Only a connection");
    await expect(router.manage({ action: "status" }, HOST_CORE_PRINCIPAL)).rejects.toMatchObject({ code: "unsupported" });
    await expect(router.manage({ action: "local-status" }, HOST_CORE_PRINCIPAL)).resolves.toMatchObject({ enabled: false });
  });

  it("rejects browsers, rebound names and missing tokens before any MCP work", async () => {
    const f = await fixture();
    const { token } = await f.manage({ action: "local-create", name: "c", projectIds: ["a"] }) as { token: string };
    const port = Number(new URL(f.local.url()!).port);
    const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const authorized = { ...json, authorization: `Bearer ${token}` };
    expect((await f.send("/mcp", { headers: { ...authorized, host: `evil.test:${port}` }, body: initialize })).status).toBe(403);
    expect((await f.send("/mcp", { headers: { ...authorized, host: "127.0.0.1" }, body: initialize })).status).toBe(403);
    expect((await f.send("/mcp", { headers: { ...authorized, origin: `http://127.0.0.1:${port}` }, body: initialize })).status).toBe(403);
    expect((await f.send("/mcp", { headers: { ...authorized, origin: "null" }, body: initialize })).status).toBe(403);
    expect((await f.send("/other", { headers: authorized, body: initialize })).status).toBe(404);
    expect((await f.send("/mcp", { headers: json, body: initialize })).status).toBe(401);
    expect((await f.send("/mcp", { method: "GET", headers: authorized })).status).toBe(405);
    expect((await f.send("/mcp", { headers: authorized, body: JSON.stringify([JSON.parse(initialize)]) })).status).toBe(400);
    expect((await f.send("/mcp", { headers: authorized, body: "x".repeat(70_000) }).catch(() => ({ status: 0 }))).status).not.toBe(200);
    const ok = await f.send("/mcp", { headers: { ...authorized, host: `localhost:${port}` }, body: initialize });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("tau-external");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await f.send("/mcp", { headers: { ...json, authorization: "Bearer tau_mcp_local_wrong" }, body: initialize })).status);
    expect(statuses).toContain(429);
  });

  it("offers read tools to a read token and control tools to a control token, through an actual SDK client", async () => {
    const f = await fixture();
    const read = await f.manage({ action: "local-create", name: "read", projectIds: ["a"] }) as { token: string };
    const control = await f.manage({ action: "local-create", name: "control", projectIds: ["a"], control: true }) as { token: string };
    const reader = await f.sdk(read.token);
    expect((await reader.listTools()).tools.map((tool) => tool.name)).toEqual(["tau_list_projects", "tau_list_threads", "tau_read_thread"]);
    const denied = await reader.callTool({ name: "tau_start_thread", arguments: { projectId: "a", prompt: "x" } });
    expect(denied.isError).toBe(true);
    const driver = await f.sdk(control.token);
    const tools = (await driver.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["tau_list_projects", "tau_list_threads", "tau_read_thread", "tau_start_thread", "tau_send_message", "tau_stop_thread", "tau_thread_status"]);
    expect(tools.find((tool) => tool.name === "tau_start_thread")!.annotations).toMatchObject({ readOnlyHint: false });
    expect(JSON.stringify(await driver.callTool({ name: "tau_list_projects", arguments: {} }))).toContain("Project a");
    expect(JSON.stringify(await driver.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } }))).toContain("Hello");
    // A reason helps the client; one naming a local path stays in the log.
    vi.mocked(f.host.startThread).mockRejectedValueOnce(new Error('Runtime backend "codex@work" is not installed.')).mockRejectedValueOnce(new Error("/private/a is not a folder"));
    expect(JSON.stringify(await driver.callTool({ name: "tau_start_thread", arguments: { projectId: "a", prompt: "x", runtime: "codex@work" } }))).toContain("is not installed");
    const hidden = JSON.stringify(await driver.callTool({ name: "tau_start_thread", arguments: { projectId: "a", prompt: "x" } }));
    expect(hidden).not.toContain("/private");
    expect(hidden).toContain("Tau's log");
  });

  it("keeps its port across restarts, closes when disabled and refuses a revoked token", async () => {
    const f = await fixture();
    const { token, id, url } = await f.manage({ action: "local-create", name: "c", projectIds: ["a"] }) as { token: string; id: string; url: string };
    await f.close();
    const again = await fixture(f.dir);
    expect(again.local.url()).toBe(url);
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
    expect((await again.send("/mcp", { headers, body: initialize })).status).toBe(200);
    await again.manage({ action: "local-revoke", id });
    expect((await again.send("/mcp", { headers, body: initialize })).status).toBe(401);
    await expect(again.manage({ action: "local-revoke", id })).rejects.toThrow("invalid_request");
    const disabled = await again.manage({ action: "local-disable" }) as LocalMcpStatus;
    expect(disabled).toMatchObject({ enabled: false, listening: false, port: Number(new URL(url).port) });
    expect(again.local.url()).toBeUndefined();
    await again.manage({ action: "local-create", name: "d", projectIds: ["a"] });
    expect(again.local.url()).toBeUndefined();
    expect(await again.manage({ action: "local-enable" })).toMatchObject({ enabled: true, listening: true, url });
  });
});
