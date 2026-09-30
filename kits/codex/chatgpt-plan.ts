import type { SignInFlowContext } from "tau/host-extension";
import type { CodexModel } from "./app-server.js";
import { ChatGPTOAuthClient, CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_USAGE_URL, PLAN_SCOPE, startChatGPTOAuth, type TokenResponse } from "./chatgpt-plan-oauth.js";
import { ChatGPTPlanStore, type ChatGPTRegistration } from "./chatgpt-plan-store.js";

export { CHATGPT_USAGE_URL };
export const CHATGPT_PLAN_METHOD = { id: "chatgpt-plan", label: "Continue with ChatGPT", actionLabel: "Continue with ChatGPT", availableWhenSignedIn: true, kind: "browser" as const, description: "Allow Tau to use your ChatGPT plan. Tau manages Codex and this account's credentials." };
export const CHATGPT_PLAN_ARGS = [
  "-c", 'model_provider="openai_chatgpt_plan"',
  "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  "-c", `model_providers.openai_chatgpt_plan.base_url="${CHATGPT_RESOURCE}"`,
  "-c", 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
  "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
  "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
  "-c", "disable_response_storage=true",
  "-c", "features.apps=false",
  "-c", "features.image_generation=false",
  // ACCESS_TOKEN is in Codex's environment: keep the *TOKEN* filter on for the commands it runs.
  "-c", "shell_environment_policy.ignore_default_excludes=false",
];

function tokens(response: TokenResponse, previous?: ChatGPTRegistration["tokens"]): NonNullable<ChatGPTRegistration["tokens"]> {
  const scopes = response.scope === undefined ? previous?.scopes ?? [] : response.scope.split(/\s+/u).filter(Boolean);
  const idToken = response.id_token ?? previous?.idToken;
  if (!idToken) throw new Error("ChatGPT did not return an identity token.");
  return { accessToken: response.access_token, refreshToken: response.refresh_token ?? previous?.refreshToken, idToken, scopes, expiresAt: Date.now() + response.expires_in * 1000 };
}

/** Owns only the selected instance's session; an account change requires a new instance. */
export class ChatGPTPlan {
  readonly store: ChatGPTPlanStore;
  private readonly oauth: ChatGPTOAuthClient;
  constructor(directory: string, fetcher?: typeof globalThis.fetch) {
    this.store = new ChatGPTPlanStore(directory);
    this.oauth = new ChatGPTOAuthClient(fetcher);
  }

  read(instance: string): Promise<ChatGPTRegistration | undefined> { return this.store.read(instance); }

  async signIn(instance: string, flow: SignInFlowContext): Promise<string> {
    const saved = await this.store.read(instance);
    const pending = await this.store.read(`pending:${instance}`);
    const attempt = await startChatGPTOAuth(await this.store.hostId(), saved ?? pending, flow.signal);
    try {
      flow.show({ browser: { url: attempt.url, instructions: "Authorize Tau in your system browser, then return here." }, links: [{ url: CHATGPT_USAGE_URL, label: "Manage usage" }] });
      const question = new AbortController();
      const pasted = flow.ask({ kind: "text", message: "The browser normally returns automatically. If it is on another computer and cannot reach Tau, paste the final http://127.0.0.1 callback URL here.", placeholder: "http://127.0.0.1:…/auth/callback?…" }, { signal: question.signal }).then((value) => { attempt.acceptCallback(value); return attempt.callback; });
      let returned;
      try { returned = await Promise.race([attempt.callback, pasted]); }
      finally { question.abort(); }
      if (!saved) await this.store.write(`pending:${instance}`, { clientId: returned.clientId, issuer: CHATGPT_ISSUER, subject: "" });
      flow.verifying("Verifying your ChatGPT account…");
      const response = await this.oauth.token({ grant_type: "authorization_code", client_id: returned.clientId, code: returned.code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri }, flow.signal);
      const next = tokens(response);
      const identity = await this.oauth.identity(next.idToken, returned.clientId, attempt.nonce);
      if (saved && (identity.subject !== saved.subject || saved.clientId !== returned.clientId)) throw new Error("This instance belongs to another ChatGPT account. Add a Codex instance for a different account.");
      if (flow.signal.aborted) throw new Error("Sign-in cancelled.");
      await this.store.lock(instance, async () => {
        if (flow.signal.aborted) throw new Error("Sign-in cancelled.");
        const current = await this.store.read(instance);
        if (current && (current.clientId !== returned.clientId || current.subject !== identity.subject)) throw new Error("This instance's account changed while signing in. Start again.");
        await this.store.write(instance, { clientId: returned.clientId, issuer: CHATGPT_ISSUER, ...identity, confirmed: saved?.confirmed ?? false, tokens: next });
        await this.store.forget(`pending:${instance}`);
      });
      if (!next.scopes.includes(PLAN_SCOPE)) return "Signed in to ChatGPT. Plan use is not enabled. Continue with ChatGPT again to authorize it.";
      if (!saved?.confirmed) {
        await flow.ask({ kind: "select", message: "Tau can now use your ChatGPT plan. Usage is shared with other apps and follows the limits you set in ChatGPT. Manage usage in ChatGPT Settings.", options: [{ id: "continue", label: "Continue" }] });
        await this.store.lock(instance, async () => {
          const current = await this.store.read(instance);
          if (current?.tokens && current.subject === identity.subject) await this.store.write(instance, { ...current, confirmed: true });
        });
      }
      return `Signed in as ${identity.email ?? "your ChatGPT account"}. Using ChatGPT plan.`;
    } finally { attempt.close(); }
  }

  /** Re-read under the process lock before consuming a rotating refresh token. */
  async credentials(instance: string): Promise<ChatGPTRegistration> {
    return this.store.lock(instance, async () => {
      let saved = await this.store.read(instance);
      if (!saved?.tokens) throw new Error("Continue with ChatGPT in Settings → Providers to sign in to this account.");
      if (!saved.tokens.scopes.includes(PLAN_SCOPE)) throw new Error("ChatGPT plan use is not enabled. Continue with ChatGPT again to authorize it.");
      if (saved.tokens.expiresAt <= Date.now() + 60_000) {
        if (!saved.tokens.refreshToken) throw new Error("Your ChatGPT session expired. Continue with ChatGPT to sign in again.");
        let response;
        try { response = await this.oauth.token({ grant_type: "refresh_token", client_id: saved.clientId, refresh_token: saved.tokens.refreshToken }); }
        catch (error) {
          if (["invalid_grant", "invalid_client"].includes((error as { code?: string }).code ?? "")) {
            const { tokens: _tokens, ...mapping } = saved;
            await this.store.write(instance, mapping);
          }
          throw error;
        }
        if (response.id_token) {
          const identity = await this.oauth.identity(response.id_token, saved.clientId);
          if (identity.subject !== saved.subject) throw new Error("The refreshed ChatGPT identity did not match this account.");
        }
        saved = { ...saved, tokens: tokens(response, saved.tokens) };
        await this.store.write(instance, saved);
        if (!saved.tokens!.scopes.includes(PLAN_SCOPE)) throw new Error("ChatGPT plan permission was removed. Authorize it again in Settings → Providers.");
      }
      return saved;
    });
  }

  async models(instance: string): Promise<CodexModel[]> {
    const saved = await this.credentials(instance);
    return (await this.oauth.models(saved.tokens!.accessToken)).map((model, index) => ({ id: model.slug, model: model.slug, displayName: model.display_name, hidden: false, isDefault: index === 0, defaultReasoningEffort: "", supportedReasoningEfforts: [] }));
  }

  async signOut(instance: string): Promise<string> {
    return this.store.lock(instance, async () => {
      const saved = await this.store.read(instance);
      if (!saved) return "Signed out of ChatGPT.";
      const revoked = await this.oauth.revoke(saved);
      const { tokens: _tokens, ...mapping } = saved;
      await this.store.write(instance, mapping);
      return revoked ? "Signed out of ChatGPT." : "Signed out locally. Remote revocation was not confirmed; disconnect Tau in ChatGPT Settings to end remote access.";
    });
  }
}
