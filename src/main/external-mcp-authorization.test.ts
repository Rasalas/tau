import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as persistence from "./persisted-json.js";
import { ExternalMcpAuthorization, type McpOAuthTokens } from "./external-mcp-authorization.js";
import { matchesMcpRedirect, mcpChallenge, mcpIssuer, mcpRedirects, mcpScopes } from "./external-mcp-policy.js";

const issuer = "https://tau.example.test";
const resource = `${issuer}/mcp`;
const verifier = "a".repeat(43);
const redirectUri = "http://127.0.0.1:43123/callback?client=terminal";
const directories: string[] = [];
const stores: ExternalMcpAuthorization[] = [];
const logger = { warn: vi.fn() };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tau-external-mcp-"));
  directories.push(dir);
  const path = join(dir, "grants.json");
  let now = 1_000_000;
  const options = { storePath: path, issuer, now: () => now, logger };
  const reopen = async () => {
    const store = await ExternalMcpAuthorization.open(options);
    stores.push(store);
    return store;
  };
  const store = await reopen();
  const client = await store.registerClient({ name: "Terminal client", redirectUris: [redirectUri] });
  const request = (scope?: string, overrides = {}) => store.requestAuthorization({ clientId: client.id, redirectUri, resource, codeChallenge: mcpChallenge(verifier), codeChallengeMethod: "S256", scope, state: "client-state", ...overrides });
  const consent = async (scope?: string) => {
    const id = request(scope);
    const approved = await store.approve(id, { projectIds: ["project-a"] });
    const code = new URL(approved.redirectUri).searchParams.get("code")!;
    const exchange = { clientId: client.id, code, codeVerifier: verifier, redirectUri, resource };
    return { id, code, exchange, approved };
  };
  const tokens = async (scope?: string) => store.exchangeCode((await consent(scope)).exchange);
  const refresh = (credentials: McpOAuthTokens, overrides = {}) => store.refresh({ clientId: client.id, refreshToken: credentials.refresh_token, resource, ...overrides });
  const lease = (credentials: McpOAuthTokens, projectId = "project-a") => store.lease(credentials.access_token, resource, { scope: "tau:read", projectId });
  return { dir, path, store, client, options, reopen, request, consent, tokens, refresh, lease, advance: (ms: number) => { now += ms; } };
}

describe("external MCP policy", () => {
  it.each(["http://tau.example.test", "https://tau.example.test/", "https://user@tau.example.test", "https://tau.example.test/mcp", "https://tau.example.test?x=1", "https://tau.example.test#x", "not a URL"])("rejects a noncanonical HTTPS issuer %s", (value) => {
    expect(() => mcpIssuer(value)).toThrow("invalid_request");
  });

  it("requires exact redirects except the native loopback IP port", () => {
    expect(matchesMcpRedirect(redirectUri, redirectUri.replace("43123", "51234"))).toBe(true);
    expect(matchesMcpRedirect("http://[::1]:123/callback", "http://[::1]:456/callback")).toBe(true);
    for (const value of [redirectUri.replace("client=terminal", "client=other"), redirectUri.replace("/callback", "/other"), redirectUri.replace("127.0.0.1", "[::1]"), redirectUri.replace("/callback", "/%63allback")]) {
      expect(matchesMcpRedirect(redirectUri, value)).toBe(false);
    }
    expect(matchesMcpRedirect("https://client.test/cb", "https://client.test:443/cb")).toBe(false);
    expect(matchesMcpRedirect("https://client.test/cb", "https://client.test/cb?x=1")).toBe(false);
  });

  it.each(["http://localhost/cb", "http://192.0.2.1/cb", "https://user:pass@client.test/cb", "https://client.test/cb#", "https://client.test/cb#fragment", "https://client.test/cb\n", "https:client.test/cb", "https://client.test\\other/cb", "javascript:alert(1)"])("rejects unsafe callback %s", (value) => {
    expect(() => mcpRedirects([value])).toThrow("invalid_request");
  });

  it("requires the read scope and accepts only the bounded vocabulary", () => {
    expect(mcpScopes()).toEqual(["tau:read"]);
    expect(mcpScopes("tau:read tau:threads")).toEqual(["tau:read", "tau:threads"]);
    for (const scope of ["", "tau:threads", "admin", "tau:read admin", "tau:read  tau:threads"]) expect(() => mcpScopes(scope)).toThrow("invalid_scope");
  });
});

describe("external MCP authorization", () => {
  it("requires explicit owner consent and stores hashes, not bearer secrets", async () => {
    const f = await fixture();
    const id = f.request();
    expect(f.store.ownerState().grants).toEqual([]);
    expect(f.store.authenticate("tau_mcp_access_forged", resource)).toBeUndefined();
    const approved = await f.store.approve(id, { projectIds: ["project-a"] });
    const location = new URL(approved.redirectUri);
    expect(location.origin).toBe(new URL(redirectUri).origin);
    expect(location.searchParams.get("client")).toBe("terminal");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect(location.searchParams.get("iss")).toBe(issuer);
    const code = location.searchParams.get("code")!;
    const tokens = await f.store.exchangeCode({ clientId: f.client.id, code, codeVerifier: verifier, redirectUri, resource });
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "tau:read" });
    expect(f.store.authenticate(tokens.access_token, resource)).toMatchObject({ clientId: f.client.id, projectIds: ["project-a"], scopes: ["tau:read"], execution: "read-only" });
    const disk = await readFile(f.path, "utf8");
    for (const secret of [tokens.access_token, tokens.refresh_token, code, verifier]) expect(disk).not.toContain(secret);
    expect(disk).toContain(createHash("sha256").update(tokens.access_token).digest("hex"));
    expect(JSON.stringify(f.store.ownerState())).not.toContain("challenge");
    expect(JSON.stringify(f.store.ownerState())).not.toContain(tokens.access_token);
    if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  });

  it("binds consent, code and token to the client, actual redirect, PKCE and resource", async () => {
    const f = await fixture();
    for (const overrides of [{ clientId: "unknown" }, { resource: "https://other.test/mcp" }, { codeChallengeMethod: "plain" }, { codeChallengeMethod: "" }, { codeChallenge: "short" }, { redirectUri: "https://evil.test/cb" }, { state: "x".repeat(2049) }]) {
      expect(() => f.request(undefined, overrides)).toThrow();
    }
    const { exchange } = await f.consent();
    for (const overrides of [{ clientId: "other" }, { resource: issuer }, { codeVerifier: "b".repeat(43) }, { codeVerifier: "short" }, { redirectUri: redirectUri.replace("43123", "43124") }]) {
      await expect(f.store.exchangeCode({ ...exchange, ...overrides })).rejects.toThrow("invalid_grant");
    }
    const tokens = await f.store.exchangeCode(exchange);
    expect(f.store.authenticate(tokens.access_token, "https://other.test/mcp")).toBeUndefined();
    for (const token of [tokens.refresh_token, exchange.code, "real-thread-token", "paired-device-key"]) expect(f.store.authenticate(token, resource)).toBeUndefined();
  });

  it("permits a native ephemeral port at authorization but binds the actual port at exchange", async () => {
    const f = await fixture();
    const actualRedirect = redirectUri.replace("43123", "59876");
    const id = f.request(undefined, { redirectUri: actualRedirect });
    const approved = await f.store.approve(id, { projectIds: ["project-a"] });
    const code = new URL(approved.redirectUri).searchParams.get("code")!;
    await expect(f.store.exchangeCode({ clientId: f.client.id, code, codeVerifier: verifier, redirectUri, resource })).rejects.toThrow("invalid_grant");
    await expect(f.store.exchangeCode({ clientId: f.client.id, code, codeVerifier: verifier, redirectUri: actualRedirect, resource })).resolves.toHaveProperty("access_token");
  });

  it("supports an exact HTTPS hosted callback without fetching it", async () => {
    const f = await fixture();
    const callback = "https://hosted-client.test/oauth/callback?tenant=one";
    const client = await f.store.registerClient({ name: "Hosted client", redirectUris: [callback] });
    const id = f.request(undefined, { clientId: client.id, redirectUri: callback });
    const approved = await f.store.approve(id, { projectIds: ["project-a"] });
    const url = new URL(approved.redirectUri);
    expect(url.origin + url.pathname).toBe("https://hosted-client.test/oauth/callback");
    expect(url.searchParams.get("tenant")).toBe("one");
    await expect(f.store.exchangeCode({ clientId: client.id, code: url.searchParams.get("code")!, codeVerifier: verifier, redirectUri: callback, resource })).resolves.toHaveProperty("access_token");
  });

  it("lets the owner narrow consent, rejects widening and defaults execution to ask", async () => {
    const f = await fixture();
    const id = f.request();
    await expect(f.store.approve(id, { projectIds: ["project-a"], scope: "tau:read tau:threads" })).rejects.toThrow("invalid_scope");
    await expect(f.store.approve(id, { projectIds: ["project-a"], execution: "full" })).rejects.toThrow("invalid_scope");
    await expect(f.store.approve(id, { projectIds: [] })).rejects.toThrow("invalid_request");
    await f.store.deny(id);
    await expect(f.store.approve(id, { projectIds: ["project-a"] })).rejects.toThrow("invalid_request");
    const narrowed = f.request("tau:read tau:threads");
    await f.store.approve(narrowed, { projectIds: ["project-a"], scope: "tau:read" });
    expect(f.store.ownerState().grants[0]).toMatchObject({ scopes: ["tau:read"], execution: "read-only" });
    const tokens = await f.tokens("tau:read tau:threads");
    expect(f.store.authenticate(tokens.access_token, resource)?.execution).toBe("ask");
  });

  it("checks project and scope on each lease and returns immutable grants", async () => {
    const f = await fixture();
    const read = await f.tokens();
    expect(() => f.lease(read, "project-b")).toThrow("access_denied");
    expect(() => f.store.lease(read.access_token, resource, { scope: "tau:threads", projectId: "project-a" })).toThrow("access_denied");
    const lease = f.lease(read);
    expect(Object.isFrozen(lease.grant)).toBe(true);
    expect(Object.isFrozen(lease.grant.projectIds)).toBe(true);
    expect(() => (lease.grant.projectIds as string[]).push("project-b")).toThrow();
    lease.release();
    lease.release();
    expect(f.store.authenticate(read.access_token, resource)?.projectIds).toEqual(["project-a"]);
  });

  it("rotates refresh tokens, narrows the new token and cannot expand the narrowed family", async () => {
    const f = await fixture();
    const original = await f.tokens("tau:read tau:threads");
    await expect(f.refresh(original, { clientId: "other" })).rejects.toThrow("invalid_grant");
    await expect(f.refresh(original, { resource: "https://other.test/mcp" })).rejects.toThrow("invalid_grant");
    const next = await f.refresh(original, { scope: "tau:read" });
    expect(next.refresh_token).not.toBe(original.refresh_token);
    expect(f.store.authenticate(next.access_token, resource)).toMatchObject({ scopes: ["tau:read"], execution: "read-only" });
    expect(f.store.authenticate(original.access_token, resource)?.scopes).toContain("tau:threads");
    await expect(f.refresh(next, { scope: "tau:read tau:threads" })).rejects.toThrow("invalid_scope");
    const third = await f.refresh(next);
    expect(third.scope).toBe("tau:read");
  });

  it("revokes the whole live grant on refresh replay, also after restart", async () => {
    const f = await fixture();
    const original = await f.tokens();
    const next = await f.refresh(original);
    f.store.close();
    const reopened = await f.reopen();
    const lease = reopened.lease(next.access_token, resource, { scope: "tau:read", projectId: "project-a" });
    await expect(reopened.refresh({ clientId: f.client.id, refreshToken: original.refresh_token, resource })).rejects.toThrow("invalid_grant");
    expect(lease.signal.aborted).toBe(true);
    expect(reopened.authenticate(next.access_token, resource)).toBeUndefined();
    expect((await f.reopen()).authenticate(next.access_token, resource)).toBeUndefined();
    await expect(reopened.refresh({ clientId: f.client.id, refreshToken: next.refresh_token, resource })).rejects.toThrow("invalid_grant");
  });

  it("serializes concurrent refreshes and treats the second use as replay", async () => {
    const f = await fixture();
    const original = await f.tokens();
    const results = await Promise.allSettled([f.refresh(original), f.refresh(original)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    if (results[0].status !== "fulfilled") throw new Error("First refresh did not succeed");
    expect(f.store.authenticate(results[0].value.access_token, resource)).toBeUndefined();
    expect(f.store.ownerState().grants).toEqual([]);
  });

  it("consumes a code once and revokes issued tokens on valid-client code replay", async () => {
    const f = await fixture();
    const { exchange } = await f.consent();
    const tokens = await f.store.exchangeCode(exchange);
    await expect(f.store.exchangeCode({ ...exchange, clientId: "other" })).rejects.toThrow("invalid_grant");
    expect(f.store.authenticate(tokens.access_token, resource)).toBeDefined();
    await expect(f.store.exchangeCode(exchange)).rejects.toThrow("invalid_grant");
    expect(f.store.authenticate(tokens.access_token, resource)).toBeUndefined();
    expect((await f.reopen()).authenticate(tokens.access_token, resource)).toBeUndefined();
  });

  it("survives restart without persisting pending requests or authorization codes", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    const pending = f.request();
    const { exchange } = await f.consent();
    f.store.close();
    const reopened = await f.reopen();
    expect(reopened.ownerState().clients).toEqual([f.client]);
    expect(reopened.ownerState().pending).toEqual([]);
    expect(reopened.authenticate(tokens.access_token, resource)).toBeDefined();
    await expect(reopened.approve(pending, { projectIds: ["project-a"] })).rejects.toThrow("invalid_request");
    await expect(reopened.exchangeCode(exchange)).rejects.toThrow("invalid_grant");
  });

  it("expires consent, codes, access tokens and finally refresh grants", async () => {
    const f = await fixture();
    const pending = f.request();
    const { exchange } = await f.consent();
    const tokens = await f.tokens();
    f.advance(5 * 60_000);
    await expect(f.store.approve(pending, { projectIds: ["project-a"] })).rejects.toThrow("invalid_request");
    await expect(f.store.exchangeCode(exchange)).rejects.toThrow("invalid_grant");
    f.advance(10 * 60_000);
    expect(f.store.authenticate(tokens.access_token, resource)).toBeUndefined();
    const refreshed = await f.refresh(tokens);
    expect(f.store.authenticate(refreshed.access_token, resource)).toBeDefined();
    f.advance(30 * 24 * 60 * 60_000);
    await expect(f.refresh(refreshed)).rejects.toThrow("invalid_grant");
    expect(f.store.ownerState().grants).toEqual([]);
  });

  it("aborts leased calls at access expiry and frees their slots", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    vi.useFakeTimers();
    const lease = f.lease(tokens);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it("revokes immediately before persistence, independently of other clients", async () => {
    const f = await fixture();
    const first = await f.tokens();
    const second = await f.tokens();
    const firstLease = f.lease(first);
    const secondLease = f.lease(second);
    const grant = f.store.authenticate(first.access_token, resource)!;
    const revocation = f.store.revokeGrant(grant.id);
    expect(firstLease.signal.aborted).toBe(true);
    expect(f.store.authenticate(first.access_token, resource)).toBeUndefined();
    await revocation;
    expect(secondLease.signal.aborted).toBe(false);
    expect(f.store.authenticate(second.access_token, resource)).toBeDefined();
    expect((await f.reopen()).authenticate(first.access_token, resource)).toBeUndefined();
  });

  it("allows token revocation only for its client and makes unknown tokens no-ops", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    await f.store.revokeToken("other", tokens.refresh_token);
    await f.store.revokeToken(f.client.id, "unknown");
    expect(f.store.authenticate(tokens.access_token, resource)).toBeDefined();
    await f.store.revokeToken(f.client.id, tokens.access_token);
    expect(f.store.authenticate(tokens.access_token, resource)).toBeUndefined();
    await f.store.revokeToken(f.client.id, tokens.refresh_token);
  });

  it("removes a client, its pending requests and all its grants durably", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    const lease = f.lease(tokens);
    f.request();
    await f.store.removeClient(f.client.id);
    expect(lease.signal.aborted).toBe(true);
    expect(f.store.ownerState()).toEqual({ clients: [], grants: [], pending: [] });
    expect(f.store.authenticate(tokens.access_token, resource)).toBeUndefined();
    expect((await f.reopen()).ownerState()).toEqual({ clients: [], grants: [], pending: [] });
    expect(() => f.request()).toThrow("invalid_client");
  });

  it("bounds pending requests and releases expired slots", async () => {
    const f = await fixture();
    for (let i = 0; i < 64; i++) f.request();
    expect(() => f.request()).toThrow("temporarily_unavailable");
    f.advance(5 * 60_000);
    expect(() => f.request()).not.toThrow();
    expect(f.store.ownerState().pending).toHaveLength(1);
  });

  it("bounds concurrent leases and recovers a released slot", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    const leases = Array.from({ length: 128 }, () => f.lease(tokens));
    expect(() => f.lease(tokens)).toThrow("temporarily_unavailable");
    leases[0].release();
    expect(() => f.lease(tokens)).not.toThrow();
  });

  it.each(["access", "refresh"] as const)("refuses exhausted %s capacity without consuming refresh or forgetting replay history", async (kind) => {
    const f = await fixture();
    const tokens = await f.tokens();
    const data = JSON.parse(await readFile(f.path, "utf8"));
    const first = data[kind][0];
    const size = kind === "access" ? 2048 : 8192;
    data[kind] = [first, ...Array.from({ length: size - 1 }, (_, index) => ({ ...first, hash: createHash("sha256").update(`seed-${kind}-${index}`).digest("hex"), ...(kind === "refresh" ? { used: true } : {}) }))];
    await writeFile(f.path, JSON.stringify(data));
    f.store.close();
    const reopened = await f.reopen();
    await expect(reopened.refresh({ clientId: f.client.id, refreshToken: tokens.refresh_token, resource })).rejects.toThrow("temporarily_unavailable");
    expect(JSON.parse(await readFile(f.path, "utf8")).refresh[0].used).toBe(false);
    expect(reopened.authenticate(tokens.access_token, resource)).toBeDefined();
    if (kind === "access") {
      f.advance(15 * 60_000);
      await expect(reopened.refresh({ clientId: f.client.id, refreshToken: tokens.refresh_token, resource })).resolves.toHaveProperty("access_token");
    } else {
      expect(JSON.parse(await readFile(f.path, "utf8")).refresh).toHaveLength(8192);
    }
  });

  it("bounds registered clients and active grants", async () => {
    const f = await fixture();
    await f.tokens();
    const data = JSON.parse(await readFile(f.path, "utf8"));
    data.clients = Array.from({ length: 64 }, (_, index) => ({ ...data.clients[0], id: index ? `client-${index}` : f.client.id }));
    data.grants = Array.from({ length: 128 }, (_, index) => ({ ...data.grants[0], id: index ? `grant-${index}` : data.grants[0].id }));
    await writeFile(f.path, JSON.stringify(data));
    f.store.close();
    const reopened = await f.reopen();
    await expect(reopened.registerClient({ name: "One too many", redirectUris: [redirectUri] })).rejects.toThrow("temporarily_unavailable");
    const id = reopened.requestAuthorization({ clientId: f.client.id, redirectUri, resource, codeChallenge: mcpChallenge(verifier), codeChallengeMethod: "S256" });
    await expect(reopened.approve(id, { projectIds: ["project-a"] })).rejects.toThrow("temporarily_unavailable");
    await reopened.revokeGrant(data.grants[0].id);
    await expect(reopened.approve(id, { projectIds: ["project-a"] })).resolves.toHaveProperty("redirectUri");
  });

  it("rejects an oversized persisted file before parsing", async () => {
    const f = await fixture();
    await writeFile(f.path, " ".repeat(4 * 1024 * 1024 + 1));
    await expect(f.reopen()).rejects.toThrow("not a bounded file");
  });

  it("does not expose mutable registrations to callers", async () => {
    const f = await fixture();
    f.client.redirectUris.push("https://evil.test/cb");
    const state = f.store.ownerState();
    state.clients[0].redirectUris.push("https://evil.test/cb");
    expect(() => f.request(undefined, { redirectUri: "https://evil.test/cb" })).toThrow("invalid_request");
  });

  it("refuses malformed, future, inconsistent and foreign-issuer stores", async () => {
    const f = await fixture();
    await f.tokens();
    const good = JSON.parse(await readFile(f.path, "utf8"));
    const invalid = [
      { ...good, version: 2 }, { ...good, issuer: "https://other.test" }, { ...good, clients: [] },
      { ...good, grants: [{ ...good.grants[0], scopes: ["admin"] }] },
      { ...good, grants: [{ ...good.grants[0], execution: "full" }] },
      { ...good, access: [{ ...good.access[0], grantId: "unknown" }] },
      { ...good, refresh: [{ ...good.refresh[0], scopes: ["tau:read", "tau:threads"] }] },
      { ...good, clients: [good.clients[0], good.clients[0]] },
      { ...good, unexpectedSecret: "reject unknown shape" },
    ];
    for (const value of invalid) {
      await writeFile(f.path, JSON.stringify(value));
      await expect(f.reopen()).rejects.toThrow();
      expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(value);
    }
    await writeFile(f.path, "{broken");
    await expect(f.reopen()).rejects.toThrow("could not be decoded");
    expect((await readdir(f.dir)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("fails closed on a real persistence failure and cancels existing calls", async () => {
    const f = await fixture();
    const tokens = await f.tokens();
    const lease = f.lease(tokens);
    await rename(f.path, `${f.path}.backup`);
    // A directory at the target path forces the real atomic rename to fail.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(f.path);
    await expect(f.refresh(tokens)).rejects.toThrow();
    expect(lease.signal.aborted).toBe(true);
    expect(() => f.store.authenticate(tokens.access_token, resource)).toThrow("temporarily_unavailable");
    expect(() => f.store.ownerState()).toThrow("temporarily_unavailable");
    const disk = await readFile(`${f.path}.backup`, "utf8");
    expect(JSON.parse(disk).refresh[0].used).toBe(false);
  });

  it("returns no token until its write finishes, and close cancels a write's result", async () => {
    const f = await fixture();
    const { exchange } = await f.consent();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const originalWrite = persistence.writePersistedJson;
    vi.spyOn(persistence, "writePersistedJson").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      await originalWrite(...args);
    });
    let settled = false;
    const promise = f.store.exchangeCode(exchange).finally(() => { settled = true; });
    await entered;
    expect(settled).toBe(false);
    expect(JSON.parse(await readFile(f.path, "utf8")).access).toEqual([]);
    f.store.close();
    release();
    await expect(promise).rejects.toThrow("temporarily_unavailable");
  });
});
