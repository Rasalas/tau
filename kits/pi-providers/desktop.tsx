import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Button, HelpTip, ProviderIconStack, SIGN_IN_EVENT, SettingRow, SettingsState, loadSignInUi, useWorkbenchShell, type DesktopExtension, type HostExtensionClient, type SettingsPageProps, type SignInEvent, type WorkbenchActions } from "tau";
import { PI_PROVIDERS_EXTENSION_ID, PI_PROVIDERS_PAGE, PROVIDERS_COMMAND, type PiProviderView } from "./protocol.js";

const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));
const CardBadge = lazy(() => loadSignInUi().then((module) => ({ default: module.ProviderCardBadgeReport })));

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

/** The element id of the list, which the search opens. */
export const LIST_ROW = "setting-pi-providers";

/** The element id of one provider's row. */
export function providerRowId(provider: PiProviderView): string {
  return `setting-pi-providers-${provider.id.replace(/[^a-z0-9-]+/giu, "-")}`;
}

/** One provider: its name and how it is set up or could be, opening into the account rows core draws. */
function ProviderRow({ provider, open, onToggle, children }: { provider: PiProviderView; open: boolean; onToggle(): void; children?: ReactNode }) {
  const verb = provider.configured ? "Manage" : "Set up";
  return (
    <SettingRow
      id={providerRowId(provider)}
      title={<><span className="pi-provider-mark" aria-hidden><ProviderIconStack modelProvider={provider.id} hint={false} /></span>{provider.name}</>}
      description={provider.configured ? setUpBy(provider) : waysIn(provider)}
      control={
        <Button variant="ghost" aria-expanded={open} aria-label={`${verb} ${provider.name}`} icon={open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} onClick={onToggle}>
          {verb}
        </Button>
      }
    >
      {open ? <div className="pi-provider-detail">{children}</div> : null}
    </SettingRow>
  );
}

/** A group's heading inside the card: its name, how many, and what the user should know about it. */
function GroupHead({ title, count, help }: { title: string; count: number; help?: string }) {
  return (
    <div className="pi-provider-group">
      <h4>{title}</h4>
      <small>{count}</small>
      {help ? <HelpTip text={help} label={`About ${title}`} /> : null}
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
    setError(undefined);
    try {
      setProviders(await host.invoke(PROVIDERS_COMMAND) as PiProviderView[]);
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
  const configured = (providers ?? []).filter((provider) => provider.configured).length;

  const row = (provider: PiProviderView) => (
    <ProviderRow key={provider.id} provider={provider} open={open === provider.id} onToggle={() => setOpen(open === provider.id ? undefined : provider.id)}>
      <SignIn
        host={host}
        target={provider.id}
        program={provider.name}
        showAccount
        cardBadge={false}
        openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
        copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
        onNotify={onNotify}
      />
    </ProviderRow>
  );

  if (error && !providers) {
    return <SettingsState kind="error" title="Pi's providers did not load" description={error} onRetry={() => void load()} />;
  }
  if (!providers) return <SettingsState kind="loading" rows={4} title="Asking Pi for its providers" />;
  return (
    <Suspense fallback={<SettingsState kind="loading" rows={4} title="Loading Pi's providers" />}>
      <CardBadge source="program" badge={configured ? { label: `${configured} set up`, tone: "success" } : { label: "None set up", tone: "warn" }} />
      <div className="pi-provider-filter" id={LIST_ROW} tabIndex={-1}>
        <label className="settings-filter">
          <Search size={14} aria-hidden />
          <input type="search" aria-label="Filter Pi's providers" placeholder="Filter providers" value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }} />
          {filter ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => setFilter("")}><X size={13} /></button> : null}
        </label>
        {error ? <p className="pi-provider-error" role="alert">{error}</p> : null}
      </div>
      {query && setUp.length === 0 && others.length === 0 ? (
        <SettingsState kind="empty" title={`No provider matches “${filter.trim()}”`} action={<Button onClick={() => setFilter("")}>Show all providers</Button>} />
      ) : null}
      {!query || setUp.length ? <GroupHead title="Set up" count={setUp.length} help="A sign-in or a key goes to Pi's own auth.json, as Pi's /login does; Tau stores none. A key in your environment counts as set up too." /> : null}
      {setUp.map(row)}
      {!query && setUp.length === 0 ? (
        <SettingsState kind="empty" title="No provider set up yet" description="Sign in to one below, or set its key in your environment and check again." action={<Button onClick={() => void load()}>Check again</Button>} />
      ) : null}
      {!query || others.length ? <GroupHead title="Sign in or add a key" count={others.length} /> : null}
      {others.map(row)}
      {!query && others.length === 0 ? <SettingsState kind="empty" title="Every provider is set up" /> : null}
    </Suspense>
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
      rows: [{ id: LIST_ROW, label: "Pi's model providers", keywords: ["login", "sign in", "api key", "auth.json", "anthropic", "openai", "google", "openrouter"] }],
      Component: (props: SettingsPageProps) => <PiProvidersCard {...props} host={plugin.host} />,
    });
  },
};

export default piProvidersExtension;
