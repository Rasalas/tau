import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignInFlowContext } from "tau/host-extension";
import { ChatGPTPlan, CHATGPT_PLAN_ARGS } from "./chatgpt-plan.js";
import { ChatGPTPlanStore } from "./chatgpt-plan-store.js";
import { ChatGPTOAuthClient, CHATGPT_ISSUER, CHATGPT_RESOURCE, PLAN_SCOPE, startChatGPTOAuth } from "./chatgpt-plan-oauth.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function scratch() { const root = await mkdtemp(join(tmpdir(), "tau-chatgpt-")); roots.push(root); return root; }

async function fixture() {
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture", alg: "RS256" };
  let subject = "account-1";
  let nonce = "nonce";
  let clientId = "oaiapp_fixture";
  let scope = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
  let access = "access-1";
  let refresh = "refresh-1";
  let failRevoke = false;
  let tokenError: string | undefined;
  let grants = 0;
  let overrides: Record<string, unknown> = {};
  const issued: URLSearchParams[] = [];
  const signed = () => new SignJWT({ nonce, email: "same@example.test", iss: CHATGPT_ISSUER, aud: clientId, sub: subject, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(keys.privateKey);
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("openid-configuration")) return Response.json({ issuer: CHATGPT_ISSUER, jwks_uri: `${CHATGPT_ISSUER}/jwks`, revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
    if (path.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (path.endsWith("/token")) {
      grants++;
      if (tokenError) return Response.json({ error: tokenError }, { status: 400 });
      issued.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: access, refresh_token: refresh, id_token: await signed(), scope, expires_in: 3600, token_type: "Bearer" });
    }
    if (path.endsWith("/models")) {
      expect((init!.headers as { Authorization: string }).Authorization).toBe(`Bearer ${access}`);
      return Response.json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }] });
    }
    if (path.endsWith("/revoke")) return new Response(null, { status: failRevoke ? 503 : 200 });
    throw new Error(`Unexpected fixture endpoint ${path}`);
  }) as typeof globalThis.fetch;
  const plan = new ChatGPTPlan(await scratch(), fetcher);
  const urls: URL[] = [];
  const controller = new AbortController();
  const confirms = vi.fn(async () => "continue");
  let callbackResult: Promise<Response> | undefined;
  const flow: SignInFlowContext = {
    flowId: "fixture", target: "default", signal: controller.signal,
    verifying: vi.fn(), ask: (prompt, options) => prompt.kind === "text" ? new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }) : confirms(),
    show: (shown) => {
      if (!shown.browser) return;
      const url = new URL(shown.browser.url);
      urls.push(url);
      nonce = url.searchParams.get("nonce")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("client_id", clientId);
      callbackResult = globalThis.fetch(callback);
    },
  };
  return { plan, flow, confirms, urls, fetcher, issued, signed, controller, callback: () => callbackResult!, grants: () => grants,
    set: (next: { subject?: string; clientId?: string; scope?: string; access?: string; refresh?: string; failRevoke?: boolean; tokenError?: string | null; overrides?: Record<string, unknown> }) => {
      if ("tokenError" in next) tokenError = next.tokenError ?? undefined;
      subject = next.subject ?? subject; clientId = next.clientId ?? clientId; scope = next.scope ?? scope;
      access = next.access ?? access; refresh = next.refresh ?? refresh; failRevoke = next.failRevoke ?? failRevoke; overrides = next.overrides ?? overrides;
    },
  };
}

describe("ChatGPT plan authorization", () => {
  it("registers with PKCE, verifies identity, protects credentials and confirms plan usage once", async () => {
    const f = await fixture();
    expect(await f.plan.signIn("default", f.flow)).toContain("Using ChatGPT plan");
    expect((await f.callback()).status).toBe(200);
    const url = f.urls[0]!;
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("tau");
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
    expect(url.searchParams.get("resource")).toBe(CHATGPT_RESOURCE);
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(f.issued[0]!.get("code_verifier")!).digest("base64url"));
    expect(f.issued[0]!.get("client_id")).toBe("oaiapp_fixture");
    expect(f.issued[0]!.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    expect(f.confirms).toHaveBeenCalledOnce();
    const saved = await f.plan.read("default");
    expect(saved).toMatchObject({ subject: "account-1", clientId: "oaiapp_fixture", confirmed: true });
    expect((await stat(f.plan.store.directory)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(f.plan.store.directory)) expect((await stat(join(f.plan.store.directory, file))).mode & 0o777).toBe(0o600);
    await f.plan.signIn("default", f.flow);
    expect(f.confirms).toHaveBeenCalledOnce();
    expect(f.urls[1]!.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(f.urls[1]!.searchParams.has("agent_name_hint")).toBe(false);
    expect(f.urls[1]!.searchParams.has("id_token_hint")).toBe(false);
    expect(f.urls[1]!.searchParams.get("ext_agent_host_id")).toBe(url.searchParams.get("ext_agent_host_id"));
  });

  it("keeps registrations with the same email isolated and rejects a returning identity change", async () => {
    const f = await fixture();
    await f.plan.signIn("one", f.flow);
    f.set({ clientId: "oaiapp_second", subject: "account-2", access: "second-access" });
    await f.plan.signIn("two", f.flow);
    expect((await f.plan.read("one"))!.tokens!.accessToken).toBe("access-1");
    expect((await f.plan.read("two"))!.tokens!.accessToken).toBe("second-access");
    f.set({ clientId: "oaiapp_fixture", refresh: "stray-refresh" });
    await expect(f.plan.signIn("one", f.flow)).rejects.toThrow("belongs to another ChatGPT account");
    expect((await f.plan.read("one"))!.subject).toBe("account-1");
    // The other account's tokens were issued to Tau; they are revoked, not only dropped.
    const revoked = vi.mocked(f.fetcher).mock.calls.filter(([url]) => String(url).endsWith("/revoke")).map(([, init]) => new URLSearchParams(String(init!.body)).get("token"));
    expect(revoked).toEqual(["stray-refresh"]);
  });

  it("does not enable inference without the granted plan scope", async () => {
    const f = await fixture();
    f.set({ scope: "openid profile email" });
    expect(await f.plan.signIn("default", f.flow)).toContain("Plan use is not enabled");
    await expect(f.plan.credentials("default")).rejects.toThrow("plan use is not enabled");
    expect(f.confirms).not.toHaveBeenCalled();
  });

  it("rejects callback state mismatch without consuming the valid pending attempt", async () => {
    const attempt = await startChatGPTOAuth("urn:uuid:fixture", undefined, new AbortController().signal);
    try {
      const callback = new URL(attempt.redirectUri);
      callback.searchParams.set("state", "wrong"); callback.searchParams.set("code", "code"); callback.searchParams.set("client_id", "oaiapp_fixture");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", attempt.state);
      expect((await fetch(callback)).status).toBe(200);
      expect(await attempt.callback).toEqual({ code: "code", clientId: "oaiapp_fixture" });
      expect((await fetch(callback)).status).toBe(400);
    } finally { attempt.close(); }
  });

  it("rejects incomplete dynamic registration and changed issued client", async () => {
    for (const saved of [undefined, { clientId: "oaiapp_original", subject: "subject", issuer: CHATGPT_ISSUER }]) {
      const attempt = await startChatGPTOAuth("urn:uuid:fixture", saved, new AbortController().signal);
      try {
        const callback = new URL(attempt.redirectUri); callback.searchParams.set("state", attempt.state); callback.searchParams.set("code", "code");
        if (saved) callback.searchParams.set("client_id", "oaiapp_other");
        expect((await fetch(callback)).status).toBe(400);
        await expect(attempt.callback).rejects.toThrow("mismatched registration");
      } finally { attempt.close(); }
    }
  });

  it("rejects invalid nonce, signature, audience, issuer and expired identity tokens", async () => {
    const f = await fixture();
    const oauth = new ChatGPTOAuthClient(f.fetcher);
    await expect(oauth.identity(await f.signed(), "oaiapp_fixture", "different")).rejects.toThrow("did not match");
    await expect(oauth.identity(await f.signed(), "wrong-client", "nonce")).rejects.toThrow("could not be verified");
    const token = await f.signed();
    await expect(oauth.identity(`${token.slice(0, -12)}AAAAAAAAAAAA`, "oaiapp_fixture", "nonce")).rejects.toThrow("could not be verified");
    for (const overrides of [{ iss: "https://attacker.test" }, { exp: 1 }]) {
      f.set({ overrides });
      await expect(oauth.identity(await f.signed(), "oaiapp_fixture", "nonce")).rejects.toThrow("could not be verified");
    }
  });

  it("refreshes once across independent managers, rotates tokens together and lists the account's models", async () => {
    const f = await fixture(); await f.plan.signIn("one", f.flow);
    const saved = (await f.plan.read("one"))!;
    await f.plan.store.write("one", { ...saved, tokens: { ...saved.tokens!, expiresAt: 1 } });
    f.set({ access: "access-2", refresh: "refresh-2" });
    const other = new ChatGPTPlan(f.plan.store.directory, f.fetcher);
    await Promise.all([f.plan.credentials("one"), other.credentials("one")]);
    expect(f.grants()).toBe(2);
    expect(f.issued[1]!.get("grant_type")).toBe("refresh_token");
    expect(f.issued[1]!.get("refresh_token")).toBe("refresh-1");
    expect(f.issued[1]!.has("scope")).toBe(false);
    expect((await f.plan.read("one"))!.tokens).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(await f.plan.models("one")).toEqual([expect.objectContaining({ id: "fixture-model", displayName: "Fixture model" })]);
  });

  it("revokes and clears only the selected account, retaining registration and host identity", async () => {
    const f = await fixture(); await f.plan.signIn("one", f.flow); await f.plan.signIn("two", f.flow);
    const host = await f.plan.store.hostId();
    expect(await f.plan.signOut("one")).toEqual({ revoked: true, message: "Signed out of ChatGPT." });
    expect(await f.plan.read("one")).toMatchObject({ clientId: "oaiapp_fixture", subject: "account-1" });
    expect((await f.plan.read("one"))!.tokens).toBeUndefined();
    expect((await f.plan.read("two"))!.tokens).toBeDefined();
    expect(await f.plan.store.hostId()).toBe(host);
    const revocation = vi.mocked(f.fetcher).mock.calls.find(([url]) => String(url).endsWith("/revoke"));
    expect(new URLSearchParams(String(revocation![1]!.body)).get("token")).toBe("refresh-1");
  });

  it("clears local credentials and reports failed remote revocation", async () => {
    const f = await fixture(); await f.plan.signIn("one", f.flow); f.set({ failRevoke: true });
    expect(await f.plan.signOut("one")).toMatchObject({ revoked: false, message: expect.stringContaining("Remote revocation was not confirmed") });
    expect((await f.plan.read("one"))!.tokens).toBeUndefined();
  });

  it("reuses the pending issued client after a failed code exchange", async () => {
    const f = await fixture(); f.set({ tokenError: "invalid_grant" });
    await expect(f.plan.signIn("default", f.flow)).rejects.toThrow("HTTP 400");
    expect(await f.plan.read("default")).toBeUndefined();
    f.set({ tokenError: null });
    await f.plan.signIn("default", f.flow);
    expect(f.urls[1]!.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(f.urls[1]!.searchParams.has("agent_name_hint")).toBe(false);
    expect(await f.plan.store.read("pending:default")).toBeUndefined();
  });

  it("makes reauthorization reachable after a revoked refresh grant", async () => {
    const f = await fixture(); await f.plan.signIn("default", f.flow);
    const saved = (await f.plan.read("default"))!;
    await f.plan.store.write("default", { ...saved, tokens: { ...saved.tokens!, expiresAt: 1 } });
    f.set({ tokenError: "invalid_grant" });
    await expect(f.plan.credentials("default")).rejects.toThrow("HTTP 400");
    expect((await f.plan.read("default"))!.tokens).toBeUndefined();
    f.set({ tokenError: null });
    await f.plan.signIn("default", f.flow);
    expect(f.urls[1]!.searchParams.get("client_id")).toBe(saved.clientId);
  });

  it("accepts a pasted callback only with this attempt's exact URI and state", async () => {
    const attempt = await startChatGPTOAuth("urn:uuid:fixture", undefined, new AbortController().signal);
    try {
      const callback = new URL(attempt.redirectUri);
      callback.searchParams.set("code", "manual-code"); callback.searchParams.set("client_id", "oaiapp_manual"); callback.searchParams.set("state", attempt.state);
      expect(() => attempt.acceptCallback(callback.href.replace("127.0.0.1", "localhost"))).toThrow("exact loopback");
      expect(() => attempt.acceptCallback(callback.href.replace(attempt.state, "other-state"))).toThrow("Invalid sign-in state");
      attempt.acceptCallback(callback.href);
      expect(await attempt.callback).toEqual({ code: "manual-code", clientId: "oaiapp_manual" });
      expect(() => attempt.acceptCallback(callback.href)).toThrow("Invalid sign-in state");
    } finally { attempt.close(); }
  });

  it("cancels its listener and rejects declined consent without exchanging credentials", async () => {
    const controller = new AbortController();
    const attempt = await startChatGPTOAuth("urn:uuid:fixture", undefined, controller.signal);
    controller.abort();
    await expect(attempt.callback).rejects.toThrow("cancelled");
    const denied = await startChatGPTOAuth("urn:uuid:fixture", undefined, new AbortController().signal);
    try {
      const callback = new URL(denied.redirectUri); callback.searchParams.set("state", denied.state); callback.searchParams.set("error", "access_denied");
      expect(() => denied.acceptCallback(callback.href)).toThrow("could not be completed");
      await expect(denied.callback).rejects.toThrow("declined");
    } finally { denied.close(); }
  });

  it("persists one host ID across stores and configures the documented Responses provider", async () => {
    const root = await scratch();
    const ids = await Promise.all([new ChatGPTPlanStore(root).hostId(), new ChatGPTPlanStore(root).hostId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(CHATGPT_PLAN_ARGS).toContain('model_providers.openai_chatgpt_plan.supports_websockets=false');
    expect(CHATGPT_PLAN_ARGS).toContain('disable_response_storage=true');
    // ACCESS_TOKEN rides in Codex's environment; the *TOKEN* filter keeps it out of commands.
    expect(CHATGPT_PLAN_ARGS).toContain("shell_environment_policy.ignore_default_excludes=false");
  });
});
