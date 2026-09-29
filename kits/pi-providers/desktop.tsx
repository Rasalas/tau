import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Button, HelpTip, ProviderIconStack, SIGN_IN_EVENT, SettingRow, SettingsState, loadSignInUi, providerHasMark, useWorkbenchShell, type DesktopExtension, type HostExtensionClient, type PreferencesStore, type SettingsPageProps, type SignInEvent, type WorkbenchActions } from "tau";
import { PI_PROVIDERS_EXTENSION_ID, PI_PROVIDERS_PAGE, PROVIDERS_COMMAND, SITE_ICON_COMMAND, type PiProviderView, type SiteIconAnswer } from "./protocol.js";
import { applySiteIcon, providerIconKey, publishProviderIcons, rasterizeIcon, readProviderIcon, syncSiteIcons, writeProviderIcon, type ProviderIconChoice, type SiteIconSync } from "./provider-icons.js";

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

/** What the card needs to show and change a provider's picture; the extension builds it from the host and its values. */
export interface ProviderIconControls {
  preferences: Pick<PreferencesStore, "value" | "setValue" | "getSnapshot" | "subscribe">;
  fetch(id: string, fresh: boolean): Promise<SiteIconAnswer>;
  rasterize(source: string | Blob): Promise<string>;
}

function iconSync(host: Pick<HostExtensionClient, "invoke">, controls: ProviderIconControls): SiteIconSync {
  return {
    providers: async () => await host.invoke(PROVIDERS_COMMAND) as PiProviderView[],
    read: (id) => readProviderIcon(controls.preferences, id),
    write: (id, choice) => writeProviderIcon(controls.preferences, id, choice),
    fetch: controls.fetch,
    rasterize: controls.rasterize,
    hasMark: providerHasMark,
    now: () => Date.now(),
  };
}

function useProviderIconChoice(controls: ProviderIconControls, id: string): ProviderIconChoice | undefined {
  const raw = useSyncExternalStore(controls.preferences.subscribe, () => controls.preferences.value(PI_PROVIDERS_EXTENSION_ID, providerIconKey(id)));
  return useMemo(() => (raw === undefined ? undefined : readProviderIcon(controls.preferences, id)), [controls, id, raw]);
}

/** Where a provider's picture comes from, for the row that changes it. */
export function logoState(provider: PiProviderView, choice: ProviderIconChoice | undefined): string {
  if (choice?.kind === "site") return `The icon of ${choice.site}.`;
  if (choice?.kind === "upload") return "Your picture.";
  if (choice?.kind === "none") return `${provider.site ?? "Its site"} has no icon Tau can use; its initial stands in.`;
  if (choice?.kind === "removed") return "Its initial, as you chose.";
  return provider.site ? `None yet; Tau fetches the icon of ${provider.site} once it is set up.` : "Its initial. Choose a picture, or give the provider a base URL.";
}

/** A provider without a mark of Tau's own: its site's icon, a picture of the user's, or its initial. */
function ProviderLogo({ provider, controls, onNotify }: { provider: PiProviderView; controls: ProviderIconControls; onNotify(message: string): void }) {
  const choice = useProviderIconChoice(controls, provider.id);
  const [busy, setBusy] = useState<"site" | "upload">();
  const file = useRef<HTMLInputElement>(null);
  const sync = useMemo(() => ({ fetch: controls.fetch, rasterize: controls.rasterize, write: (id: string, next: ProviderIconChoice) => writeProviderIcon(controls.preferences, id, next), now: () => Date.now() }), [controls]);
  const fromSite = async () => {
    setBusy("site");
    try {
      if (!await applySiteIcon(sync, provider.id, true)) onNotify(`${provider.site ?? provider.name} has no icon Tau can use.`);
    } catch (failure) {
      onNotify(`Could not fetch the icon of ${provider.site ?? provider.name}: ${errorMessage(failure)}`);
    } finally {
      setBusy(undefined);
    }
  };
  const upload = async (picked: File) => {
    setBusy("upload");
    try {
      writeProviderIcon(controls.preferences, provider.id, { kind: "upload", image: await controls.rasterize(picked) });
    } catch (failure) {
      onNotify(`Could not read ${picked.name}: ${errorMessage(failure)}`);
    } finally {
      setBusy(undefined);
    }
  };
  const hasPicture = choice?.kind === "site" || choice?.kind === "upload";
  return (
    <SettingRow
      title="Logo"
      description={logoState(provider, choice)}
      control={
        <div className="pi-provider-logo">
          <span className="pi-provider-logo-mark" aria-hidden><ProviderIconStack modelProvider={provider.id} hint={false} /></span>
          {provider.site ? <Button busy={busy === "site"} disabled={Boolean(busy)} onClick={() => void fromSite()}>{choice?.kind === "site" ? "Check again" : "Use site icon"}</Button> : null}
          <Button busy={busy === "upload"} disabled={Boolean(busy)} onClick={() => file.current?.click()}>Choose…</Button>
          {hasPicture ? <Button variant="ghost" disabled={Boolean(busy)} onClick={() => writeProviderIcon(controls.preferences, provider.id, { kind: "removed" })}>Remove</Button> : null}
          <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon" aria-label={`Picture for ${provider.name}`}
            onChange={(event) => { const picked = event.target.files?.[0]; event.target.value = ""; if (picked) void upload(picked); }} />
        </div>
      }
    />
  );
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
export function PiProvidersCard({ host, icons, onNotify }: SettingsPageProps & { host: HostExtensionClient; icons?: ProviderIconControls }) {
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
  // Opening the card is a check: a provider set up since the last one gets its site icon.
  useEffect(() => { if (icons && providers) void syncSiteIcons({ ...iconSync(host, icons), providers: async () => providers }); }, [host, icons, providers]);
  // A finished flow or a sign-out anywhere changes what is set up.
  useEffect(() => host.onEvent(SIGN_IN_EVENT, (payload) => { if ((payload as SignInEvent | undefined)?.report) void load(); }), [host, load]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => (providers ?? []).filter((provider) => !query || provider.name.toLowerCase().includes(query) || provider.id.includes(query)), [providers, query]);
  const setUp = shown.filter((provider) => provider.configured);
  const others = shown.filter((provider) => !provider.configured && (provider.oauth || provider.apiKey?.interactive));
  const configured = (providers ?? []).filter((provider) => provider.configured).length;

  const row = (provider: PiProviderView) => (
    <ProviderRow key={provider.id} provider={provider} open={open === provider.id} onToggle={() => setOpen(open === provider.id ? undefined : provider.id)}>
      {icons && !providerHasMark(provider.id) ? <ProviderLogo provider={provider} controls={icons} onNotify={onNotify} /> : null}
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
    const icons: ProviderIconControls = {
      preferences: plugin.preferences,
      fetch: async (id, fresh) => await plugin.host.invoke(SITE_ICON_COMMAND, { id, fresh }) as SiteIconAnswer,
      rasterize: (source) => rasterizeIcon(source),
    };
    const unpublish = publishProviderIcons(plugin.preferences, (pictures) => plugin.setProviderIcons(pictures));
    // A provider added or signed in shows up in the next catalog; its site icon is fetched then, once.
    let known = "";
    let running: Promise<unknown> | undefined;
    const check = () => { running ??= syncSiteIcons(iconSync(plugin.host, icons)).catch(() => 0).finally(() => { running = undefined; }); };
    const stopWatching = plugin.events.on("models-changed", ({ providers }) => {
      const signature = providers.join("\n");
      if (signature === known) return;
      known = signature;
      check();
    });
    const page = plugin.registerSettingsPage({
      id: PI_PROVIDERS_PAGE,
      label: "Pi",
      profiles: ["desktop", "web"],
      runtime: "pi",
      order: 0,
      keywords: ["pi", "login", "sign in", "api key", "provider", "anthropic", "openai", "google", "openrouter"],
      rows: [{ id: LIST_ROW, label: "Pi's model providers", keywords: ["login", "sign in", "api key", "auth.json", "anthropic", "openai", "google", "openrouter"] }],
      Component: (props: SettingsPageProps) => <PiProvidersCard {...props} host={plugin.host} icons={icons} />,
    });
    return () => { page(); stopWatching(); unpublish(); };
  },
};

export default piProvidersExtension;
