import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { ChatGPTRegistration } from "./chatgpt-plan-store.js";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";

interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint: string }
export interface OAuthAttempt {
  url: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  callback: Promise<{ code: string; clientId: string }>;
  acceptCallback(url: string): void;
  close(): void;
}

/** Only an exact loopback callback and a matching pending state may consume a code. */
export async function startChatGPTOAuth(hostId: string, saved: ChatGPTRegistration | undefined, signal: AbortSignal): Promise<OAuthAttempt> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  let resolve!: (value: { code: string; clientId: string }) => void;
  let reject!: (error: Error) => void;
  const callback = new Promise<{ code: string; clientId: string }>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation can precede the caller awaiting the callback.
  void callback.catch(() => undefined);
  let consumed = false;
  const consume = (url: URL): { status: number; message: string } => {
    if (consumed || url.searchParams.get("state") !== state) return { status: 400, message: "Invalid sign-in state." };
    consumed = true;
    const failure = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const returned = url.searchParams.get("client_id");
    const clientId = returned ?? saved?.clientId;
    if (failure || !code || !clientId || clientId === "dynamic_agent_client" || (saved && clientId !== saved.clientId)) {
      reject(new Error(failure === "access_denied" ? "ChatGPT access was declined." : "ChatGPT returned an incomplete or mismatched registration."));
      return { status: 400, message: "Sign-in could not be completed. Return to Tau." };
    }
    resolve({ code, clientId });
    return { status: 200, message: "You can return to Tau. It is verifying your ChatGPT account." };
  };
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { response.writeHead(400).end("Invalid callback URL."); return; }
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
    const result = consume(url);
    response.writeHead(result.status, { "Content-Type": "text/plain; charset=utf-8" }).end(result.message);
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { server.off("error", no); yes(); }); });
  const close = () => { signal.removeEventListener("abort", cancel); server.close(); server.closeAllConnections(); };
  const cancel = () => { reject(new Error("Sign-in cancelled.")); close(); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const port = (server.address() as { port: number } | null)?.port;
  if (!port) throw new Error("Sign-in cancelled.");
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  const params: Record<string, string> = {
    client_id: saved?.clientId ?? "dynamic_agent_client", ext_agent_host_id: hostId,
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: CHATGPT_RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(!saved ? { agent_name_hint: "tau" } : {}),
    ...(saved?.email ? { login_hint: saved.email } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const acceptCallback = (value: string) => {
    const pasted = new URL(value.trim());
    const expected = new URL(redirectUri);
    if (pasted.origin !== expected.origin || pasted.pathname !== expected.pathname || pasted.hash) throw new Error("Paste the exact loopback callback URL from this sign-in attempt.");
    const result = consume(pasted);
    if (result.status !== 200) throw new Error(result.message);
  };
  return { url: url.href, redirectUri, state, nonce, verifier, callback, acceptCallback, close };
}

export interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; token_type: string; scope?: string }

/** Network errors never include endpoint responses, which may contain credentials. */
export class ChatGPTOAuthClient {
  private discovery?: Promise<Discovery>;
  private keys?: JSONWebKeySet;
  constructor(private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {}

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(25_000), redirect: "error" });
    if (!response.ok) {
      let code: string | undefined;
      try { const data = await response.json() as { error?: unknown }; if (typeof data.error === "string" && ["invalid_grant", "invalid_client"].includes(data.error)) code = data.error; } catch { /* Never expose raw endpoint responses. */ }
      throw Object.assign(new Error(`ChatGPT request failed (HTTP ${response.status}). Sign in again if access has expired.`), { code });
    }
    try { return await response.json() as T; }
    catch { throw new Error("ChatGPT returned an unreadable response."); }
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= this.json<Discovery>(`${CHATGPT_ISSUER}/.well-known/openid-configuration`).then((document) => {
      if (document.issuer !== CHATGPT_ISSUER) throw new Error("ChatGPT returned an unexpected identity issuer.");
      for (const endpoint of [document.jwks_uri, document.revocation_endpoint]) {
        if (new URL(endpoint).origin !== CHATGPT_ISSUER) throw new Error("ChatGPT returned an unexpected identity endpoint.");
      }
      return document;
    }).catch((error) => { this.discovery = undefined; throw error; });
    return this.discovery;
  }

  async token(params: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
    const result = await this.json<TokenResponse>(`${CHATGPT_ISSUER}/api/accounts/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, resource: CHATGPT_RESOURCE }), ...(signal ? { signal } : {}),
    });
    if (!result.access_token || result.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error("ChatGPT returned an invalid token response.");
    return result;
  }

  async identity(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email?: string }> {
    const discovery = await this.discover();
    this.keys ??= await this.json<JSONWebKeySet>(discovery.jwks_uri);
    const verify = () => jwtVerify(idToken, createLocalJWKSet(this.keys!), { issuer: CHATGPT_ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
    let result;
    try { result = await verify(); }
    catch (error) {
      // JWT errors can carry identity claims. Keep them out of diagnostics.
      // eslint-disable-next-line preserve-caught-error
      if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw new Error("ChatGPT identity could not be verified.");
      this.keys = await this.json<JSONWebKeySet>(discovery.jwks_uri);
      try { result = await verify(); } catch { throw new Error("ChatGPT identity could not be verified."); }
    }
    if (!result.payload.sub || (nonce !== undefined && result.payload.nonce !== nonce)) throw new Error("ChatGPT identity did not match this sign-in attempt.");
    return { subject: result.payload.sub, ...(typeof result.payload.email === "string" ? { email: result.payload.email } : {}) };
  }

  async revoke(registration: ChatGPTRegistration): Promise<boolean> {
    if (!registration.tokens?.refreshToken) return true;
    try {
      const discovery = await this.discover();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.fetcher(discovery.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: registration.tokens.refreshToken, token_type_hint: "refresh_token", client_id: registration.clientId }), signal: AbortSignal.timeout(10_000), redirect: "error" });
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch { /* Retry while this renewable session is still available. */ }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    } catch { return false; }
    return false;
  }

  async models(accessToken: string): Promise<Array<{ slug: string; display_name: string }>> {
    const result = await this.json<{ models: Array<{ slug: string; display_name: string; visibility: string }> }>(`${CHATGPT_RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!Array.isArray(result.models)) throw new Error("ChatGPT returned an invalid model catalog.");
    return result.models.filter((model) => model.visibility === "list" && typeof model.slug === "string" && typeof model.display_name === "string");
  }
}
