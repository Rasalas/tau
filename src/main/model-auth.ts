import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One of Pi's model providers, how it signs in and whether it is set up. */
export interface HostModelProviderAuth {
  id: string;
  name: string;
  /** Pi can reach it now: a stored key or login, an environment variable, `models.json`. */
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  /** Where the credential comes from, for the user's eyes: `ANTHROPIC_API_KEY`, `OAuth`. */
  label?: string;
  /** What Pi's own file holds for it; a sign-out removes exactly this. */
  stored?: "api_key" | "oauth";
  /** A key typed in; `interactive` is false for a provider that reads only ambient credentials. */
  apiKey?: { name: string; interactive: boolean };
  /** A login in the provider's own pages; `subscription` when it spends a consumer plan. */
  oauth?: { name: string; label?: string; subscription: boolean };
}

/** A question during a login; `signal` aborts it when the flow no longer needs the answer. */
export type HostModelAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: ReadonlyArray<{ id: string; label: string; description?: string }> }
);

export type HostModelAuthEvent =
  | { type: "info"; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface HostModelAuthInteraction {
  signal: AbortSignal;
  prompt(prompt: HostModelAuthPrompt): Promise<string>;
  notify(event: HostModelAuthEvent): void;
}

/**
 * Pi's model providers and their credentials, in the file Pi keeps them in
 * (`<agentDir>/auth.json`). A login or a key goes straight from the flow to
 * Pi; nothing here reads a stored secret back.
 */
export interface HostModelAuthServices {
  providers(): Promise<HostModelProviderAuth[]>;
  login(providerId: string, type: "api_key" | "oauth", interaction: HostModelAuthInteraction): Promise<void>;
  logout(providerId: string): Promise<void>;
}

const REFRESH_TIMEOUT_MS = 5_000;

export interface ModelAuthOptions {
  /** The runtime whose credential store is Pi's file: the host's own, the one small jobs complete on. */
  runtime(): Promise<ModelRuntime>;
  /** A credential was added or removed: catalogs and model lists are asked again. */
  changed(): void;
}

export function createModelAuth(options: ModelAuthOptions): HostModelAuthServices {
  const provider = async (providerId: string) => {
    const runtime = await options.runtime();
    const found = runtime.getProvider(providerId);
    if (!found) throw new Error(`Pi knows no provider “${providerId}”.`);
    return { runtime, found };
  };
  return {
    providers: async () => {
      const runtime = await options.runtime();
      const stored = new Map((await runtime.listCredentials().catch(() => [])).map((entry) => [entry.providerId, entry.type]));
      return runtime.getProviders().map((entry): HostModelProviderAuth => {
        const status = runtime.getProviderAuthStatus(entry.id);
        const kind = stored.get(entry.id);
        const { apiKey, oauth } = entry.auth;
        return {
          id: entry.id,
          name: entry.name || entry.id,
          configured: status.configured,
          ...(status.source ? { source: status.source } : {}),
          ...(status.label ? { label: status.label } : {}),
          ...(kind ? { stored: kind } : {}),
          ...(apiKey ? { apiKey: { name: apiKey.name, interactive: typeof apiKey.login === "function" } } : {}),
          ...(oauth ? { oauth: { name: oauth.name, ...(oauth.loginLabel ? { label: oauth.loginLabel } : {}), subscription: oauth.isSubscription === true } } : {}),
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    },
    login: async (providerId, type, interaction) => {
      const { runtime, found } = await provider(providerId);
      if (type === "oauth" ? !found.auth.oauth : !found.auth.apiKey?.login) throw new Error(`${found.name} has no ${type === "oauth" ? "sign-in" : "key to enter"}.`);
      await runtime.login(providerId, type, interaction);
      // A provider whose models come from its account (a gateway) names them only once signed in.
      await runtime.refresh({ providers: [providerId], allowNetwork: process.env.PI_OFFLINE === undefined, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }).catch(() => undefined);
      options.changed();
    },
    logout: async (providerId) => {
      const { runtime } = await provider(providerId);
      await runtime.logout(providerId);
      options.changed();
    },
  };
}
