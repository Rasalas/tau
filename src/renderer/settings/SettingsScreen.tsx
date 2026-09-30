import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, Blocks, Bot, ChevronLeft, ChevronRight, Command, Cpu, Info, MonitorSmartphone, Puzzle, Search, Server, Settings2, Sparkles, X, type LucideIcon } from "lucide-react";
import type { HostSnapshot, UiProject } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { usePreferences } from "../renderer-services-context";
import { useHostClient } from "../host-client-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { useAppPageStore } from "../app-page-context";
import { PanelIcon, type PanelIconComponent } from "../components/PanelIcon";
import { PiSettingsPage } from "../components/PiSettingsPage";
import { WindowControlsInset } from "../components/WindowControlsInset";
import { isMacPlatform } from "../keybindings";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { ConfigLayersStore, type SettingsProject } from "../../workbench/config-layers-store";
import { searchSettings, settingsSearchEntries, type SettingsSearchEntry } from "./settings-search";
import { CORE_PAGE_DESCRIPTIONS, CORE_PAGE_TITLES, CORE_SETTINGS_PAGES, extensionOfPage, extensionPage, parentSettingsPage, parseSettingsTarget, settingsNavGroupOpen, settingsNavGroups, settingsTarget, type SettingsNavGroup } from "./settings-nav";
import { SettingsLevelsProvider } from "./settings-layout";
import { SettingsPageActionSlot } from "./page-action";
import { SettingsPageHead, type SettingsCrumb } from "./page-head";
import { extensionCatalog, needsAttention } from "./extension-catalog";
import { AboutPage } from "./AboutPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { GeneralPage } from "./GeneralPage";
import { ModelsPage } from "./ModelsPage";
import { ExtensionPage, ExtensionPageFallback, useExtensionSources } from "./ExtensionPage";
import { ExtensionsPage } from "./ExtensionsPage";
import { InspectorPage } from "./InspectorPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { ProvidersPage, providerCardId } from "./ProvidersPage";
import { RuntimesPage } from "./RuntimesPage";
import { inRuntimeOrder } from "../runtime-order";
import "./settings.css";

function projectName(path?: string): string {
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "project";
}

/** The workspace on screen, as the project Settings reads levels for; named as the project list names it. */
function currentProject(snapshot: HostSnapshot | undefined, projects: readonly UiProject[]): SettingsProject | undefined {
  const workspaceId = snapshot?.workspaceId ?? snapshot?.cwd;
  if (!workspaceId) return undefined;
  const listed = projects.find((project) => project.workspaceId === workspaceId || project.path === snapshot?.cwd);
  return { workspaceId, label: listed?.name || projectName(snapshot?.cwd), ...(snapshot?.cwd ? { path: snapshot.cwd } : {}) };
}

const CORE_ICONS: Readonly<Record<string, LucideIcon>> = {
  general: Settings2,
  keybindings: Command,
  models: Sparkles,
  providers: Server,
  runtimes: Bot,
  pi: Cpu,
  connections: MonitorSmartphone,
  extensions: Blocks,
  inspector: Puzzle,
  about: Info,
};

interface NavItem {
  id: string;
  label: string;
  group: SettingsNavGroup | undefined;
  order: number | undefined;
  Icon: PanelIconComponent | undefined;
}

/** The groups the user opened, kept while the window lives; one they folded follows the page on screen again next time. */
let navFolds: Partial<Record<SettingsNavGroup, true | undefined>> = {};

/**
 * Settings as a page of its own that takes the whole window. A navigation
 * column with the search on the left, its pages in groups; a top bar with the
 * page and the level a change is written to; the page below at a readable
 * width. `page` is a place in Settings
 * (`settings-nav.ts`): a page, an extension's page, and a row to scroll to.
 * Escape and ⌘, return to where Settings was opened from; Back to thread to the thread.
 */
export function SettingsScreen({
  page: target,
  snapshot,
  registry,
  projects = [],
  onSetPage,
  onSetModel,
  onSetThinking,
  onClose,
  onNotify,
  stacked = false,
  view,
  onViewChange,
  nav,
}: {
  page: string;
  snapshot?: HostSnapshot;
  registry: ExtensionRegistry;
  projects?: readonly UiProject[];
  onSetPage(page: string): void;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  onClose(): void;
  onNotify(message: string): void;
  /** One column, as on a phone: the section list first, a page after a tap, and back. */
  stacked?: boolean;
  /** Stacked, which of the two shows, when the caller keeps it (a phone's history does). */
  view?: "sections" | "page";
  onViewChange?(view: "sections" | "page"): void;
  /** A phone's bottom navigation, under the list of sections; Settings is then a main page, without Close. */
  nav?: ReactNode;
}) {
  const preferences = usePreferences();
  const client = useHostClient();
  const { readOnly } = useHostCapabilities();
  const appPages = useAppPageStore();
  // Past an app page Settings was opened over, too.
  const onBackToThread = () => { onClose(); appPages?.close(); };
  const { disabledExtensions } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [levels] = useState(() => new ConfigLayersStore(client, () => void preferences.syncFromHost()));
  const project = currentProject(snapshot, projects);
  useEffect(() => { levels.setProject(project); }, [levels, project?.workspaceId, project?.label]);
  // A push that changed a file, or the palette's theme, moves the levels too.
  useEffect(() => {
    void levels.refresh();
    return preferences.subscribe(() => void levels.refresh());
  }, [levels, preferences]);

  const { page: requested, anchor } = parseSettingsTarget(target);
  const [answered, setAnswered] = useState(0);
  const sources = useExtensionSources(snapshot?.cwd, answered);
  const loaded = registry.getExtensionSummaries();
  const catalog = extensionCatalog({
    summaries: loaded,
    packages: sources.inspection?.packages ?? [],
    hostHalves: sources.hostHalves,
    errors: sources.inspection?.errors ?? [],
    skipped: sources.inspection?.skipped ?? [],
    disabled: disabledExtensions,
  });
  // Pages extensions own. Core keeps General, Models, Keybindings and the
  // Inspector, so safe mode still has a model picker and a way to see what is loaded.
  const contributions = registry.getSettingsPages();
  // A page about a runtime is a card on Providers, not a page of its own.
  const providers = inRuntimeOrder(contributions.filter((entry) => entry.runtime), (entry) => entry.runtime, snapshot?.runtimeBackends);
  const pages = contributions.filter((entry) => !entry.runtime && !entry.standalone);
  const contributed = contributions.find((entry) => !entry.runtime && entry.id === requested);
  const isCore = requested in CORE_PAGE_TITLES;
  // An extension's id alone is the older link to its page.
  const extensionId = extensionOfPage(requested) ?? (!isCore && !contributed && catalog.some((entry) => entry.id === requested) ? requested : undefined);
  const page = extensionId ? extensionPage(extensionId) : requested;
  const extension = extensionId ? catalog.find((entry) => entry.id === extensionId) : undefined;
  const installer = pages.find((entry) => entry.id === "packages");
  const onProviders = providers.length > 0 && (page === "providers" || providers.some((card) => card.id === page));
  const pageLabel = onProviders ? "Providers"
    : extensionId ? extension?.name ?? "Extension"
      : CORE_PAGE_TITLES[page as keyof typeof CORE_PAGE_TITLES] ?? contributed?.label ?? "Settings";
  const parent = parentSettingsPage(page);
  // Pages that write settings a project may override.
  const pageScope = page === "general" || page === "models" || onProviders ? "both" : contributed?.scope ?? "host";
  const showScope = pageScope !== "host";
  const pageDescription = onProviders ? CORE_PAGE_DESCRIPTIONS.providers
    : extensionId ? undefined
      : CORE_PAGE_DESCRIPTIONS[page as keyof typeof CORE_PAGE_DESCRIPTIONS] ?? contributed?.description;
  const parentLabel = parent ? CORE_PAGE_TITLES[parent as keyof typeof CORE_PAGE_TITLES] ?? parent : undefined;
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  // An extension's page draws its own title beside its mark.
  const ownTitle = Boolean(extensionId && extension);
  const crumbs: SettingsCrumb[] = parent ? [
    { label: "Settings", open: () => onSetPage("general") },
    { label: parentLabel!, open: () => onSetPage(parent) },
  ] : [];
  // A page without project rows edits this machine; leaving one puts the scope back.
  useEffect(() => { if (!showScope) levels.edit("host"); }, [levels, showScope]);

  const [ownShowingPage, setOwnShowingPage] = useState(!stacked);
  const showingPage = view && stacked ? view === "page" : ownShowingPage;
  const setShowingPage = (showing: boolean) => { if (onViewChange) onViewChange(showing ? "page" : "sections"); else setOwnShowingPage(showing); };
  // What the section list opens; stacked, it also turns from the list to the page.
  const openPage = (id: string) => { onSetPage(id); setShowingPage(true); };
  const [search, setSearch] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  // What a keybinding result filtered the Keybindings page to; a new result remounts it.
  const [keybindingFilter, setKeybindingFilter] = useState<{ filter: string; seq: number }>({ filter: "", seq: 0 });
  const commands = registry.getCommands();
  const found = search.trim() ? searchSettings(settingsSearchEntries({
    // A runtime's card is found like a page: its id opens Providers at the card.
    pages: [...pages, ...providers].map((entry) => ({ id: entry.id, label: entry.label, description: entry.description, keywords: entry.keywords, extensionName: entry.extensionName, rows: entry.rows })),
    sections: (["connections", "extensions", "runtimes"] as const).flatMap((sectionPage) => registry.getSettingsSections(sectionPage)),
    extensions: catalog.map((entry) => ({ id: entry.id, name: entry.name, core: entry.locked, options: entry.summary?.options ?? [] })),
    keybindings: registry.getKeybindings().map((binding) => ({
      commandId: binding.commandId,
      keys: binding.keys,
      label: binding.label,
      commandLabel: commands.find((command) => command.id === binding.commandId)?.label,
    })),
  }), search) : [];
  const clearSearch = () => { setSearch(""); setActiveResult(0); };
  const openFound = (entry: SettingsSearchEntry) => {
    if (entry.filter !== undefined) setKeybindingFilter((current) => ({ filter: entry.filter!, seq: current.seq + 1 }));
    clearSearch();
    openPage(settingsTarget(entry.page, entry.target));
  };

  // A link that names a row hands it to the scroll below and keeps the page alone.
  useEffect(() => {
    if (!anchor) return;
    setScrollTarget(anchor);
    onSetPage(page);
  }, [anchor, onSetPage, page]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // A row a link named scrolls into view once it is drawn. Some rows wait for the host, and what
  // loads above one moves it, so it is kept in view for a moment, until the user scrolls.
  useEffect(() => {
    if (!scrollTarget) return;
    let shown: HTMLElement | undefined;
    let settle: number | undefined;
    const finish = () => { observer.disconnect(); setScrollTarget(undefined); };
    const show = () => {
      const row = document.getElementById(scrollTarget);
      if (!row) return;
      row.scrollIntoView?.({ block: "center" });
      if (row === shown) return;
      shown = row;
      row.focus({ preventScroll: true });
      row.classList.remove("settings-target-pulse");
      void row.offsetWidth;
      row.classList.add("settings-target-pulse");
      window.clearTimeout(settle);
      settle = window.setTimeout(finish, 3_000);
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { childList: true, subtree: true });
    show();
    const scroller = scrollRef.current;
    const userMoved = () => { if (shown) finish(); };
    scroller?.addEventListener("wheel", userMoved, { passive: true });
    scroller?.addEventListener("touchmove", userMoved, { passive: true });
    // A row that never comes (a section of a kit that is off) ends the watch.
    const giveUp = window.setTimeout(finish, 10_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(giveUp);
      window.clearTimeout(settle);
      scroller?.removeEventListener("wheel", userMoved);
      scroller?.removeEventListener("touchmove", userMoved);
    };
  }, [page, scrollTarget]);

  // A card's own id opens Providers at that card; every other page starts at the top.
  useEffect(() => {
    const card = onProviders && page !== "providers" ? document.getElementById(providerCardId(page)) : null;
    if (card?.scrollIntoView) card.scrollIntoView({ block: "start" });
    else scrollRef.current?.scrollTo?.({ top: 0 });
  }, [onProviders, page]);

  useEffect(() => {
    const mac = isMacPlatform();
    // Capture: the workbench's own ⌘, would open Settings again.
    const toggle = (event: KeyboardEvent) => {
      if (event.key !== "," || event.altKey || event.shiftKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}]`)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Another dialog (a picker opened from a page) closes first.
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return;
      const typing = event.target instanceof HTMLElement && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.tagName === "SELECT" || event.target.isContentEditable);
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      onClose();
    };
    window.addEventListener("keydown", toggle, true);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", toggle, true);
      window.removeEventListener("keydown", keydown);
    };
  }, [onClose]);

  const navItems: NavItem[] = [
    ...CORE_SETTINGS_PAGES
      .filter((entry) => entry.id !== "providers" || providers.length > 0)
      .map((entry) => ({ id: entry.id, label: entry.label, group: entry.group, order: entry.order, Icon: CORE_ICONS[entry.id] })),
    ...pages.map((entry) => ({ id: entry.id, label: entry.label, group: entry.group, order: entry.order, Icon: entry.Icon })),
  ];
  const attention = catalog.filter(needsAttention).length;
  const iconOf = (id: string): PanelIconComponent | undefined => CORE_ICONS[id] ?? (extensionOfPage(id) ? Blocks : pages.find((entry) => entry.id === id)?.Icon);
  const activeNav = onProviders ? "providers" : parent ?? page;
  // A folding group as the user left it, also last time Settings was open; unset, it follows the page on screen.
  const [toggledGroups, setToggledGroups] = useState<Partial<Record<SettingsNavGroup, boolean>>>(navFolds);
  const navButton = (item: NavItem) => (
    <button
      key={item.id}
      type="button"
      className={activeNav === item.id ? "active" : ""}
      aria-current={activeNav === item.id ? "page" : undefined}
      onClick={() => {
        if (item.id === "keybindings") setKeybindingFilter((current) => ({ filter: "", seq: current.seq + 1 }));
        openPage(item.id);
      }}
    >
      <PanelIcon Icon={item.Icon} size={15} /><span>{item.label}</span>
      {item.id === "extensions" && attention > 0 ? <small className="settings-nav-count" aria-label={`${attention} need attention`}>{attention}</small> : null}
    </button>
  );
  const versions = client?.getVersions();
  const version = versions?.window ?? versions?.host;

  if (contributed?.standalone) return (
    <SettingsLevelsProvider store={levels}>
      <div className="settings-screen standalone-page" role="dialog" aria-modal="true" aria-label={pageLabel} data-preview-overlay="">
        <main className="settings-main">
          <header className="settings-topbar">
            <WindowControlsInset />
            <button type="button" className="standalone-back settings-back" onClick={onClose}><ArrowLeft size={15} /><span>Back</span></button>
            <h1>{pageLabel}</h1>
          </header>
          <div className="settings-scroll" ref={scrollRef}>
            <div className="settings-content" data-page={page}>
              <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} onOpenSettings={openPage} />
            </div>
          </div>
        </main>
      </div>
    </SettingsLevelsProvider>
  );

  const extensionSections = registry.getSettingsSections("extension");
  return (
    <SettingsLevelsProvider store={levels}>
      <div className={stacked ? "settings-screen stacked" : "settings-screen"} data-view={stacked ? (showingPage ? "page" : "sections") : undefined} role="dialog" aria-modal="true" aria-label="Settings" data-preview-overlay="">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-header">{stacked ? <>
            <h1>Settings</h1>
            {showingPage || nav ? null : <button type="button" className="settings-sections-back" aria-label="Close settings" onClick={onClose}><X size={18} /></button>}
          </> : <WindowControlsInset />}</div>
          {stacked ? null : <button type="button" className="settings-back settings-back-top" onClick={onBackToThread}><ChevronLeft size={15} /><span>Back to thread</span></button>}
          <label className="settings-nav-search">
            <Search size={14} />
            <input
              ref={searchRef}
              type="search"
              value={search}
              placeholder="Search settings"
              aria-label="Search settings"
              role="searchbox"
              aria-controls={found.length > 0 ? "settings-search-results" : undefined}
              aria-activedescendant={found[activeResult] ? `settings-search-result-${activeResult}` : undefined}
              onChange={(event) => { setSearch(event.target.value); setActiveResult(0); }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); clearSearch(); return; }
                if (found.length === 0) return;
                if (event.key === "ArrowDown") { event.preventDefault(); setActiveResult((index) => (index + 1) % found.length); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActiveResult((index) => (index - 1 + found.length) % found.length); }
                if (event.key === "Enter") { event.preventDefault(); const entry = found[activeResult]; if (entry) openFound(entry); }
              }}
            />
            {search ? (
              <button type="button" className="settings-nav-search-clear" aria-label="Clear settings search" onClick={() => { clearSearch(); searchRef.current?.focus(); }}><X size={12} /></button>
            ) : <kbd className="keyboard-hint">/</kbd>}
          </label>
          <div className="settings-nav-list">
            {search.trim() ? <>
              {found.length > 0 ? <div id="settings-search-results" role="listbox" aria-label="Settings search results">
                {found.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    id={`settings-search-result-${index}`}
                    role="option"
                    aria-selected={index === activeResult}
                    className={`settings-search-result ${index === activeResult ? "active" : ""}`}
                    onMouseMove={() => setActiveResult(index)}
                    onClick={() => openFound(entry)}
                  >
                    <PanelIcon Icon={iconOf(entry.page)} size={14} />
                    <span><span>{entry.label}</span><small>{entry.description ?? entry.section}</small></span>
                  </button>
                ))}
              </div> : <p className="settings-search-empty" role="status">No setting matches “{search.trim()}”.</p>}
            </> : settingsNavGroups(navItems).map((group) => {
              const open = settingsNavGroupOpen(group, activeNav, toggledGroups);
              const waiting = group.id === "extensions" && !open && attention > 0;
              return (
                <div key={group.id} className="settings-nav-group" role="group" aria-label={group.label} data-folds={group.folds ? "" : undefined}>
                  {group.folds ? (
                    <h2 className="settings-nav-heading">
                      <button type="button" className="settings-nav-fold" aria-expanded={open} onClick={() => { navFolds = { ...navFolds, [group.id]: !open || undefined }; setToggledGroups((current) => ({ ...current, [group.id]: !open })); }}>
                        <ChevronRight size={12} aria-hidden /><span>{group.label}</span>
                        {waiting ? <small className="settings-nav-count" aria-label={`${attention} need attention`}>{attention}</small> : null}
                      </button>
                    </h2>
                  ) : <h2 className="settings-nav-heading">{group.label}</h2>}
                  {open ? group.items.map(navButton) : null}
                </div>
              );
            })}
          </div>
          <div className="settings-nav-footer">
            <button type="button" className={`settings-about-link ${page === "about" ? "active" : ""}`} aria-current={page === "about" ? "page" : undefined} onClick={() => openPage("about")}>
              <Info size={15} /><span>About Tau</span>{version ? <small>{version}</small> : null}
            </button>
            <button type="button" className="settings-back" onClick={onBackToThread}>
              <ChevronLeft size={15} /><span>Back to thread</span>
            </button>
          </div>
          {stacked && !showingPage ? nav : null}
        </nav>

        <main className="settings-main">
          <header className="settings-topbar">
            {stacked ? <>
              <button type="button" className="settings-sections-back" aria-label={parentLabel ? `Back to ${parentLabel}` : "All settings"} onClick={() => (parent ? onSetPage(parent) : setShowingPage(false))}><ChevronLeft size={18} /></button>
              {ownTitle ? <span className="settings-topbar-title">{pageLabel}</span> : <h1 className="settings-topbar-title">{pageLabel}</h1>}
            </> : null}
            {stacked && showingPage && !nav ? <button type="button" className="settings-sections-back settings-close" aria-label="Close settings" onClick={onClose}><X size={18} /></button> : null}
          </header>
          <div className="settings-scroll" ref={scrollRef}>
            <div className="settings-content" data-page={page}>
              <SettingsPageHead
                title={stacked || ownTitle ? undefined : page === "about" ? "Tau" : pageLabel}
                description={page === "about" ? undefined : pageDescription}
                crumbs={stacked ? [] : crumbs}
                scope={showScope ? { projects, current: project } : undefined}
                actionSlot={setActionSlot}
              />
              {readOnly ? <p className="settings-read-only" role="note">This device is paired Read only: the host keeps its settings as they are. Theme and layout stay on this device.</p> : null}
              <SettingsPageActionSlot.Provider value={actionSlot}>
                {page === "general" ? (
                  <GeneralPage themeHere={!pages.some((entry) => entry.keywords?.includes("theme"))} />
                ) : page === "models" ? (
                  <ModelsPage snapshot={snapshot} providersHere={providers.length > 0} onSetModel={onSetModel} onSetThinking={onSetThinking} onOpen={openPage} />
                ) : page === "runtimes" ? (
                  <RuntimesPage snapshot={snapshot} cards={providers} sections={registry.getSettingsSections("runtimes")} onOpen={openPage} onNotify={onNotify} />
                ) : page === "keybindings" ? (
                  <KeybindingsPage key={keybindingFilter.seq} registry={registry} initialFilter={keybindingFilter.filter} onNotify={onNotify} />
                ) : page === "pi" ? (
                  <PiSettingsPage snapshot={snapshot} onNotify={onNotify} />
                ) : onProviders ? (
                  <ProvidersPage cards={providers} backends={snapshot?.runtimeBackends} cwd={snapshot?.cwd} onNotify={onNotify} />
                ) : contributed ? (
                  <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} onOpenSettings={openPage} />
                ) : page === "extensions" ? (
                  <ExtensionsPage
                    entries={sources.loading && !sources.inspection && snapshot?.cwd ? [] : catalog}
                    registry={registry}
                    loading={sources.loading}
                    error={sources.error}
                    sections={registry.getSettingsSections("extensions")}
                    installPage={installer?.id}
                    onOpen={openPage}
                    onRetry={sources.refresh}
                    onNotify={onNotify}
                    onHostHalves={sources.setHostHalves}
                    onChanged={() => setAnswered((count) => count + 1)}
                  />
                ) : extensionId ? (
                  extension ? (
                    <ExtensionPage
                      entry={extension}
                      registry={registry}
                      models={snapshot?.completionModels ?? snapshot?.models ?? []}
                      cwd={snapshot?.cwd}
                      distribution={sources.inspection?.distribution}
                      sections={extensionSections}
                      trustPage={installer?.id}
                      onOpen={openPage}
                      onChanged={() => setAnswered((count) => count + 1)}
                      onNotify={onNotify}
                      onHostHalves={sources.setHostHalves}
                    />
                  ) : <ExtensionPageFallback loading={sources.loading} onBack={() => onSetPage("extensions")} />
                ) : page === "inspector" ? (
                  <InspectorPage registry={registry} cwd={snapshot?.cwd} />
                ) : page === "connections" ? (
                  <ConnectionsPage onNotify={onNotify} sections={registry.getSettingsSections("connections")} />
                ) : page === "about" ? (
                  <AboutPage />
                ) : (
                  <div className="settings-page"><p className="lede">This page is gone; its extension may have been turned off.</p></div>
                )}
              </SettingsPageActionSlot.Provider>
            </div>
          </div>
        </main>
      </div>
    </SettingsLevelsProvider>
  );
}
