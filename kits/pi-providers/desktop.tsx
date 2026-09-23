import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, Search } from "lucide-react";
import { SIGN_IN_EVENT, loadSignInUi, useWorkbenchShell, type DesktopExtension, type HostExtensionClient, type SettingsPageProps, type SignInEvent, type WorkbenchActions } from "tau";
import { PI_PROVIDERS_EXTENSION_ID, PI_PROVIDERS_PAGE, PROVIDERS_COMMAND, type PiProviderView } from "./protocol.js";

const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));

function useShellActions(): WorkbenchActions | undefined {
  try {
    return useWorkbenchShell().actions;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How a provider signs in, for its row: "Sign in · API key". */
export function waysIn(provider: PiProviderView): string {
  const ways = [provider.oauth ? (provider.oauth.subscription ? "Subscription" : "Sign in") : undefined, provider.apiKey?.interactive ? "API key" : undefined].filter(Boolean);
  return ways.length ? ways.join(" · ") : "Environment only";
}

/** Where a set-up provider's credential comes from, for its row. */
export function setUpBy(provider: PiProviderView): string {
  if (provider.stored === "oauth") return "Signed in";
  if (provider.stored === "api_key") return "API key";
  if (provider.source === "environment") return provider.label ?? "Environment";
  return provider.label ?? "Set up";
}

function ProviderRow({ provider, open, onToggle, children }: { provider: PiProviderView; open: boolean; onToggle(): void; children?: ReactNode }) {
  return (
    <div className="pi-provider" data-open={open || undefined}>
      <button type="button" className="pi-provider-row" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <strong>{provider.name}</strong>
        <small>{provider.configured ? setUpBy(provider) : waysIn(provider)}</small>
        {provider.configured ? <CircleCheck size={13} className="accent" aria-label="Set up" /> : null}
      </button>
      {open ? <div className="pi-provider-body">{children}</div> : null}
    </div>
  );
}

/**
 * Pi's card on the Providers page: the model providers Pi reaches now, and
 * every other one it can sign in to or take a key for, as Pi's `/login` offers
 * them. A row opens the account rows core draws (`loadSignInUi`).
 */
export function PiProvidersCard({ host, onNotify }: SettingsPageProps & { host: HostExtensionClient }) {
  const [providers, setProviders] = useState<PiProviderView[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string>();
  const actions = useShellActions();

  const load = useCallback(async () => {
    try {
      setProviders(await host.invoke(PROVIDERS_COMMAND) as PiProviderView[]);
      setError(undefined);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [host]);
  useEffect(() => { void load(); }, [load]);
  // A finished flow or a sign-out anywhere changes what is set up.
  useEffect(() => host.onEvent(SIGN_IN_EVENT, (payload) => { if ((payload as SignInEvent | undefined)?.report) void load(); }), [host, load]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => (providers ?? []).filter((provider) => !query || provider.name.toLowerCase().includes(query) || provider.id.includes(query)), [providers, query]);
  const setUp = shown.filter((provider) => provider.configured);
  const others = shown.filter((provider) => !provider.configured && (provider.oauth || provider.apiKey?.interactive));

  const row = (provider: PiProviderView) => (
    <ProviderRow key={provider.id} provider={provider} open={open === provider.id} onToggle={() => setOpen(open === provider.id ? undefined : provider.id)}>
      <Suspense fallback={null}>
        <SignIn
          host={host}
          target={provider.id}
          program={provider.name}
          showAccount
          openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
          copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
          onNotify={onNotify}
        />
      </Suspense>
    </ProviderRow>
  );

  return (
    <>
      <p className="settings-note">
        Pi reaches a model through the providers set up here or in your environment. A sign-in or a key goes to Pi's
        own <code>auth.json</code>, as Pi's <code>/login</code> does; Tau stores none.
      </p>
      {error ? <p className="settings-note" data-level="error" role="alert">{error}</p> : null}
      {!providers && !error ? <p className="settings-note">Asking Pi for its providers…</p> : null}
      {providers ? (
        <>
          <label className="settings-filter pi-provider-filter">
            <Search size={13} aria-hidden />
            <input aria-label="Filter Pi's providers" placeholder="Filter providers" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <div className="settings-label">Set up ({setUp.length})</div>
          {setUp.length ? <div className="pi-provider-list">{setUp.map(row)}</div> : <p className="pi-provider-empty">{query ? "None matches." : "None yet: sign in to one below or set its key in your environment."}</p>}
          <div className="settings-label">Sign in or add a key ({others.length})</div>
          {others.length ? <div className="pi-provider-list">{others.map(row)}</div> : <p className="pi-provider-empty">{query ? "None matches." : "Every provider is set up."}</p>}
        </>
      ) : null}
    </>
  );
}

/** Pi's card on the Providers page, first in the runtime order. */
export const piProvidersExtension: DesktopExtension = {
  id: PI_PROVIDERS_EXTENSION_ID,
  name: "Pi Providers",
  activate(plugin) {
    return plugin.registerSettingsPage({
      id: PI_PROVIDERS_PAGE,
      label: "Pi",
      profiles: ["desktop", "web"],
      runtime: "pi",
      order: 0,
      keywords: ["pi", "login", "sign in", "api key", "provider", "anthropic", "openai", "google", "openrouter"],
      Component: (props: SettingsPageProps) => <PiProvidersCard {...props} host={plugin.host} />,
    });
  },
};

export default piProvidersExtension;
