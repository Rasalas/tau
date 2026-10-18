import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { createServer as httpServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ThreadIndexSnapshot } from "../shared/contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { ExternalMcpHttp } from "./external-mcp-http.js";
import { hostHttpListener } from "./host-http-route.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { HOST_CORE_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import { mcpChallenge } from "./external-mcp-policy.js";

const issuer = "https://tau.fixture.test";
const resource = `${issuer}/mcp`;
const callback = "http://127.0.0.1:43123/cb";
const verifier = "a".repeat(43);
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), "tau-mcp-http-"));
  cleanup.push(() => rm(userData, { recursive: true, force: true }));
  const index: ThreadIndexSnapshot = {
    projects: ["a", "b"].map((id) => ({ name: `Project ${id}`, workspaceId: id, path: `/private/${id}`, lastOpenedAt: 1 })),
    sessions: [
      { id: "thread-a", title: "Allowed", workspaceId: "a", projectPath: "/private/a", projectName: "a", path: "/private/session-a", modifiedAt: 1, messageCount: 1 },
      { id: "thread-b", title: "Other project", workspaceId: "b", projectPath: "/private/b", projectName: "b", path: "/private/session-b", modifiedAt: 1, messageCount: 1 },
      { id: "remote-a", title: "Remote", workspaceId: "a", projectPath: "/remote", projectName: "a", path: "/remote/session", modifiedAt: 1, messageCount: 1, machine: { id: "remote", name: "Remote" } },
    ], complete: true,
  };
  const loadTranscript = vi.fn(async (threadId: string): Promise<TranscriptPage> => ({ sessionId: threadId, hasMore: false, messages: [{ id: "m", role: "user", text: "Allowed conversation", timestamp: 1, thinking: "not exported", images: [{ data: "private attachment", mimeType: "image/png" }] }] }));
  let now = Date.now();
  const service = await ExternalMcpHttp.open({ userData, issuer, browserOrigins: ["https://client.fixture.test"], host: async () => ({ threadIndexSnapshot: () => index, loadTranscript }), version: "test", now: () => now });
  cleanup.push(() => service.close());
  const material = createSelfSignedCertificate({ commonName: "tau.fixture.test", dnsNames: ["tau.fixture.test"], ipAddresses: ["127.0.0.1"], days: 1 });
  const tls = httpsServer(material, hostHttpListener((request, response, trust) => service.handle(request, response, trust), "loopback", (_request, response) => { response.end("fallback"); }));
  const plain = httpServer(hostHttpListener((request, response, trust) => service.handle(request, response, trust), "loopback"));
  const proxy = httpServer(hostHttpListener((request, response, trust) => service.handle(request, response, trust), "proxy"));
  for (const server of [tls, plain, proxy]) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  }
  const send = async (path: string, init: RequestInit = {}, target: Server = tls): Promise<Response> => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const req = (target === tls ? httpsRequest : httpRequest)({ hostname: "127.0.0.1", port: (target.address() as { port: number }).port, path, method: init.method ?? "GET", headers: { host: "tau.fixture.test", ...headers }, ca: material.cert, servername: "tau.fixture.test", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(new Response([204, 304].includes(response.statusCode!) ? null : Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) })));
    });
    req.once("error", reject);
    if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("cancelled")), { once: true });
    req.end(init.body ? String(init.body) : undefined);
  });
  const form = (fields: Record<string, string>, path = "/oauth/token") => send(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const manage = (input: unknown, principal: HostInvocationPrincipal = HOST_CORE_PRINCIPAL) => service.manage(input, principal);
  const registered = await manage({ action: "register", name: "Terminal", redirectUris: [callback, "https://hosted.fixture.test/cb"] }) as { id: string };
  const authorize = async (extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ response_type: "code", client_id: registered.id, redirect_uri: callback, resource, code_challenge: mcpChallenge(verifier), code_challenge_method: "S256", state: "client-state", ...extra });
    return send(`/oauth/authorize?${params}`);
  };
  const login = async (extra: Record<string, string> = {}) => {
    const waiting = await authorize(extra);
    expect(waiting.status).toBe(303);
    const location = waiting.headers.get("location")!;
    const requestId = new URL(location, issuer).searchParams.get("request_id")!;
    await manage({ action: "approve", requestId, projectIds: ["a"] });
    const approved = await send(location);
    const redirect = new URL(approved.headers.get("location")!);
    const tokenResponse = await form({ grant_type: "authorization_code", client_id: registered.id, redirect_uri: extra.redirect_uri ?? callback, resource, code: redirect.searchParams.get("code")!, code_verifier: verifier });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    return { tokens, requestId, redirect };
  };
  const sdk = async (token: string) => {
    const client = new Client({ name: "fixture", version: "1" });
    cleanup.push(() => client.close());
    const fetcher: typeof fetch = (url, init) => send(new URL(String(url)).pathname, init);
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetcher }));
    return client;
  };
  return { userData, service, index, loadTranscript, tls, plain, proxy, send, form, manage, registered, authorize, login, sdk, advance: (ms: number) => { now += ms; } };
}

describe("external MCP HTTPS", () => {
  it("publishes resource and AS discovery with a bearer challenge", async () => {
    const f = await fixture();
    const missing = await f.send("/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(`${issuer}/.well-known/oauth-protected-resource/mcp`);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await f.send(path)).json()).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ["tau:read"] });
    }
    const metadata = await (await f.send("/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({ issuer, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(metadata).not.toHaveProperty("registration_endpoint");
    expect((await f.send("/unrelated")).status).toBe(200);
    expect(await (await f.send("/unrelated")).text()).toBe("fallback");
  });

  it("requires actual TLS or the explicit local proxy and never trusts Forwarded", async () => {
    const f = await fixture();
    expect((await f.send("/.well-known/oauth-protected-resource", { headers: { "x-forwarded-proto": "https", forwarded: "proto=https;host=tau.fixture.test" } }, f.plain)).status).toBe(403);
    expect((await f.send("/.well-known/oauth-protected-resource", {}, f.proxy)).status).toBe(200);
    expect((await f.send("/.well-known/oauth-protected-resource", { headers: { host: "evil.test" } })).status).toBe(403);
  });

  it("allows only exact browser origins and explicit preflight headers", async () => {
    const f = await fixture();
    expect((await f.send("/mcp", { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await f.send("/mcp", { headers: { origin: "null" } })).status).toBe(403);
    const allowed = await f.send("/mcp", { method: "OPTIONS", headers: { origin: "https://client.fixture.test" } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://client.fixture.test");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("requires owner consent and never lets the public browser approve itself", async () => {
    const f = await fixture();
    const response = await f.authorize();
    const location = response.headers.get("location")!;
    const page = await f.send(location);
    expect(page.status).toBe(200);
    expect(page.headers.get("refresh")).toContain("2;url=/oauth/consent");
    expect(await page.text()).toContain("Waiting for the machine's owner");
    expect((await f.send(location, { method: "POST", body: "approve=true" })).status).toBe(405);
    expect((await f.send(`${location}&approve=true`)).status).toBe(400);
    const status = await f.manage({ action: "status" }) as { grants: unknown[]; pending: Array<{ id: string }>; projects: Array<{ id: string }> };
    expect(status.grants).toEqual([]);
    expect(status.pending).toHaveLength(1);
    await expect(f.manage({ action: "approve", requestId: status.pending[0]!.id, projectIds: ["/arbitrary/path"] })).rejects.toThrow("invalid_request");
    expect(status.projects.map((project) => project.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(status)).not.toContain("client-state");
  });

  it.each<HostInvocationPrincipal>([
    { kind: "workbench-client", connection: "remote" },
    { kind: "workbench-client", connection: "paired", local: true, pairedClient: "device" },
    { kind: "host-extension", contextId: "extension" },
  ])("refuses management by a non-owner %j", async (principal) => {
    const f = await fixture();
    await expect(f.manage({ action: "status" }, principal)).rejects.toThrow("Only a connection");
    await expect(f.manage({ action: "register", name: "forged", redirectUris: [callback] }, principal)).rejects.toThrow("Only a connection");
  });

  it.each([callback, "https://hosted.fixture.test/cb"])("completes a PKCE flow to registered callback %s", async (redirect_uri) => {
    const f = await fixture();
    const { tokens, redirect } = await f.login({ redirect_uri });
    expect(redirect.origin + redirect.pathname).toBe(new URL(redirect_uri).origin + new URL(redirect_uri).pathname);
    expect(redirect.searchParams.get("iss")).toBe(issuer);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    const status = await f.manage({ action: "status" });
    expect(JSON.stringify(status)).not.toContain(tokens.access_token);
    const disk = await readFile(join(f.userData, "external-mcp-grants.json"), "utf8");
    expect(disk).not.toContain(tokens.refresh_token);
  });

  it("dispatches only bounded read tools through an actual SDK client", async () => {
    const f = await fixture();
    const { tokens } = await f.login();
    const client = await f.sdk(tokens.access_token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["tau_list_projects", "tau_list_threads", "tau_read_thread"]);
    const projects = await client.callTool({ name: "tau_list_projects", arguments: {} });
    expect(JSON.stringify(projects)).toContain("Project a");
    expect(JSON.stringify(projects)).not.toContain("Project b");
    const threads = await client.callTool({ name: "tau_list_threads", arguments: { projectId: "a" } });
    expect(JSON.stringify(threads)).toContain("thread-a");
    expect(JSON.stringify(threads)).not.toContain("remote-a");
    expect(JSON.stringify(threads)).not.toContain("/private/");
    const conversation = await client.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } });
    expect(JSON.stringify(conversation)).toContain("Allowed conversation");
    expect(JSON.stringify(conversation)).not.toContain("not exported");
    expect(JSON.stringify(conversation)).not.toContain("private attachment");
    for (const args of [{ projectId: "b", threadId: "thread-b" }, { projectId: "a", threadId: "thread-b" }, { projectId: "a", threadId: "remote-a" }, { projectId: "a", threadId: "../../secret" }]) {
      expect((await client.callTool({ name: "tau_read_thread", arguments: args })).isError).toBe(true);
    }
    expect(f.loadTranscript).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "start-thread", arguments: {} })).isError).toBe(true);
  });

  it("rotates tokens and rejects the whole grant after refresh reuse", async () => {
    const f = await fixture();
    const { tokens } = await f.login();
    const fields = { grant_type: "refresh_token", client_id: f.registered.id, resource, refresh_token: tokens.refresh_token };
    const next = await (await f.form(fields)).json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await f.form(fields)).status).toBe(400);
    expect((await f.send("/mcp", { method: "POST", headers: { authorization: `Bearer ${next.access_token}` } })).status).toBe(401);
  });

  it("suppresses an in-flight read after owner revocation", async () => {
    const f = await fixture();
    const { tokens } = await f.login();
    const client = await f.sdk(tokens.access_token);
    let finish!: (page: TranscriptPage) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.loadTranscript.mockImplementationOnce(async () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
    const read = client.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } });
    await started;
    const status = await f.manage({ action: "status" }) as { grants: Array<{ id: string }> };
    await f.manage({ action: "revoke", grantId: status.grants[0]!.id });
    const result = await read;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("revoked secret");
    finish({ sessionId: "thread-a", hasMore: false, messages: [{ id: "m", role: "assistant", text: "revoked secret", timestamp: 1 }] });
  });

  it("denies expired consent, write scope, malformed PKCE and duplicate parameters", async () => {
    const f = await fixture();
    const response = await f.authorize();
    const location = response.headers.get("location")!;
    f.advance(5 * 60_000);
    expect((await f.send(location)).status).toBe(410);
    expect((await f.authorize({ scope: "tau:read tau:threads" })).status).toBe(400);
    f.advance(60_000);
    expect((await f.authorize({ code_challenge_method: "plain" })).status).toBe(400);
    f.advance(60_000);
    expect((await f.send(`/oauth/authorize?response_type=code&response_type=code`)).status).toBe(400);
  });

  it("rate limits public authorization and refuses oversized forms", async () => {
    const f = await fixture();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await f.authorize()).status);
    expect(statuses).toContain(429);
    f.advance(60_000);
    await expect(f.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `client_id=${"x".repeat(70_000)}` })).rejects.toThrow();
  });

  it("rejects wrong resources, callback changes, duplicate fields and unverified wire versions", async () => {
    const f = await fixture();
    expect((await f.authorize({ resource: "https://other.fixture.test/mcp" })).status).toBe(400);
    expect((await f.authorize({ redirect_uri: "https://evil.fixture.test/cb" })).status).toBe(400);
    const { tokens } = await f.login();
    f.advance(60_000);
    const duplicate = await f.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `client_id=${f.registered.id}&client_id=${f.registered.id}` });
    expect(duplicate.status).toBe(400);
    const future = await f.send("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "future", version: "1" } } }) });
    expect(future.status).toBe(400);
  });

  it("denies pending requests and removes client access, without claiming denial of an approved request", async () => {
    const f = await fixture();
    const waiting = await f.authorize();
    const path = waiting.headers.get("location")!;
    const id = new URL(path, issuer).searchParams.get("request_id")!;
    await f.manage({ action: "deny", requestId: id });
    expect((await f.send(path)).status).toBe(403);
    const { tokens, requestId } = await f.login();
    await expect(f.manage({ action: "deny", requestId })).rejects.toThrow("invalid_request");
    await f.manage({ action: "remove", clientId: f.registered.id });
    expect((await f.send("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
  });

  it("bounds actual reads even after cancelled clients have received their errors", async () => {
    const f = await fixture();
    const { tokens } = await f.login();
    const client = await f.sdk(tokens.access_token);
    const finish: Array<(page: TranscriptPage) => void> = [];
    let entered!: () => void;
    const allEntered = new Promise<void>((resolve) => { entered = resolve; });
    for (let i = 0; i < 16; i++) f.loadTranscript.mockImplementationOnce(() => new Promise((resolve) => { finish.push(resolve); if (finish.length === 16) entered(); }));
    const reads = Array.from({ length: 16 }, () => client.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } }));
    await allEntered;
    const status = await f.manage({ action: "status" }) as { grants: Array<{ id: string }> };
    await f.manage({ action: "revoke", grantId: status.grants[0]!.id });
    expect((await Promise.all(reads)).every((read) => read.isError)).toBe(true);
    const fresh = await f.login();
    const next = await f.sdk(fresh.tokens.access_token);
    const blocked = await next.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain("temporarily_unavailable");
    expect(f.loadTranscript).toHaveBeenCalledTimes(16);
    for (const resolve of finish) resolve({ sessionId: "thread-a", hasMore: false, messages: [] });
    const resumed = await next.callTool({ name: "tau_read_thread", arguments: { projectId: "a", threadId: "thread-a" } });
    expect(resumed.isError).not.toBe(true);
  });
});
