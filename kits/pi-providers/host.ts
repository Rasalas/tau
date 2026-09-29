import {
  HostCommandError,
  registerSignIn,
  type HostExtension,
  type HostModelAuthPrompt,
  type HostModelProviderAuth,
  type SignInAccount,
  type SignInFlowContext,
  type SignInMethod,
} from "tau/host-extension";
import { join } from "node:path";
import { PI_PROVIDERS_EXTENSION_ID, PROVIDERS_COMMAND, SITE_ICON_COMMAND, type PiProviderView, type SiteIconAnswer } from "./protocol.js";
import { fetchSiteIcon, isLocalProvider, SiteIconCache } from "./site-icon.js";

/** The ways a provider signs in, as Pi's `/login` offers them. */
export function providerMethods(provider: HostModelProviderAuth): SignInMethod[] {
  return [
    ...(provider.oauth ? [{
      id: "oauth",
      label: provider.oauth.label ?? `Sign in to ${provider.oauth.name}`,
      kind: "browser" as const,
      description: provider.oauth.subscription ? "Uses your subscription plan instead of an API key." : "Signs in in the provider's own pages.",
    }] : []),
    ...(provider.apiKey?.interactive ? [{ id: "api-key", label: "Enter an API key", kind: "api-key" as const, description: `${provider.apiKey.name}; billed per token.` }] : []),
  ];
}

/** What reaches the provider now, and whether a sign-out has anything of Pi's to remove. */
export function providerAccount(provider: HostModelProviderAuth): SignInAccount {
  if (provider.stored === "oauth") return { signedIn: true, label: provider.oauth?.name ?? "Signed in", detail: "Pi keeps the login in its auth.json", canSignOut: true };
  if (provider.stored === "api_key") return { signedIn: true, label: "API key", detail: "Pi keeps the key in its auth.json", canSignOut: true };
  if (!provider.configured) return { signedIn: false };
  const from = provider.source === "environment" ? "from your environment" : provider.source?.startsWith("models_json") ? "from models.json" : "set up outside Tau";
  return { signedIn: true, label: provider.label ?? provider.name, detail: from, canSignOut: false };
}

/** Where a provider's API lives, as far as a window needs to know: the host name, never the address. */
function siteOf(baseUrl: string | undefined): string | undefined {
  try {
    const url = baseUrl ? new URL(baseUrl) : undefined;
    return url && (url.protocol === "http:" || url.protocol === "https:") ? url.host : undefined;
  } catch {
    return undefined;
  }
}

function view(provider: HostModelProviderAuth): PiProviderView {
  const { baseUrl, ...rest } = provider;
  const site = siteOf(baseUrl);
  return { ...rest, ...(site ? { site } : {}) };
}

/** Pi's question, asked in the flow; a manual code is the text a provider's page shows or the address it ends on. */
function ask(flow: SignInFlowContext, prompt: HostModelAuthPrompt): Promise<string> {
  const signal = prompt.signal;
  const question = prompt.type === "select"
    ? { kind: "select" as const, message: prompt.message, options: prompt.options }
    : { kind: prompt.type === "manual_code" ? "code" as const : prompt.type, message: prompt.message, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) };
  return flow.ask(question, signal ? { signal } : undefined);
}

/**
 * Pi's providers on a Providers card: each signs in the way Pi's own `/login`
 * does, through the host seam (`services.modelAuth`), which hands the login or
 * the key straight to Pi. This half keeps nothing.
 */
export function createPiProvidersHostExtension(): HostExtension {
  return {
    id: PI_PROVIDERS_EXTENSION_ID,
    name: "Pi Providers",
    permissions: ["runtime:extend"],
    isolation: "in-process",
    activate(context) {
      const auth = context.services.modelAuth;
      const seam = () => {
        if (!auth) throw new HostCommandError("This host cannot sign Pi's providers in.");
        return auth;
      };
      const find = async (id: string) => {
        const provider = (await seam().providers()).find((entry) => entry.id === id);
        if (!provider) throw new HostCommandError(`Pi knows no provider “${id}”.`);
        return provider;
      };
      context.registerCommand(PROVIDERS_COMMAND, async () => (await seam().providers()).map(view), { access: "read" });
      const icons = new SiteIconCache(join(context.services.stateDir, "site-icons.json"), (origin, local) => fetchSiteIcon(origin, { allowPrivate: local }));
      // Takes a provider id, never an address, so no client can point the host at a URL of its choosing.
      context.registerCommand(SITE_ICON_COMMAND, async (input): Promise<SiteIconAnswer> => {
        const { id, fresh } = (input ?? {}) as { id?: unknown; fresh?: unknown };
        if (typeof id !== "string") throw new HostCommandError("Name the provider.");
        const provider = await find(id);
        const site = siteOf(provider.baseUrl);
        if (!site || !provider.baseUrl) return {};
        const image = await icons.icon(provider.baseUrl, { fresh: fresh === true, local: await isLocalProvider(provider.baseUrl) });
        return { site, ...(image ? { image } : {}) };
      }, { audit: { label: "looked up a provider's site icon", automatic: true } });
      const signIn = registerSignIn(context, {
        report: async (id) => {
          const provider = await find(id);
          return { methods: providerMethods(provider), account: providerAccount(provider), note: "Pi keeps logins and keys in its own auth.json; Tau stores none." };
        },
        signIn: async (id, method, flow) => {
          const provider = await find(id);
          await seam().login(id, method === "oauth" ? "oauth" : "api_key", {
            signal: flow.signal,
            prompt: (prompt) => ask(flow, prompt),
            notify: (event) => {
              if (event.type === "auth_url") flow.show({ browser: { url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) } });
              else if (event.type === "device_code") flow.show({ deviceCode: { url: event.verificationUri, code: event.userCode, ...(event.expiresInSeconds ? { expiresAt: Date.now() + event.expiresInSeconds * 1000 } : {}) } });
              else if (event.type === "info") flow.show({ message: event.message, ...(event.links ? { links: event.links } : {}) });
              else flow.show({ message: event.message });
            },
          });
          return `Signed in to ${provider.name}.`;
        },
        signOut: async (id) => {
          const provider = await find(id);
          if (!provider.stored) throw new Error(`Pi stores nothing for ${provider.name}; it comes ${providerAccount(provider).detail ?? "from elsewhere"}.`);
          await seam().logout(id);
          return `Signed out of ${provider.name}.`;
        },
      });
      return () => signIn.dispose();
    },
  };
}

export default createPiProvidersHostExtension;
