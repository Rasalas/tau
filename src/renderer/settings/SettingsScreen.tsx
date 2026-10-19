import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Activity, ArrowLeft, Blocks, Bot, ChevronLeft, ChevronRight, Command, Info, ListTree, MonitorSmartphone, Search, Settings2, X, type LucideIcon } from "lucide-react";
import type { HostSnapshot, UiProject, UiSession } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { usePreferences } from "../renderer-services-context";
import { useHostClient } from "../host-client-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { usePlatform } from "../platform-context";
import { useAppPageStore } from "../app-page-context";
import { PanelIcon, type PanelIconComponent } from "../components/PanelIcon";
import { WindowControlsInset } from "../components/WindowControlsInset";
import { isMacPlatform } from "../keybindings";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { ConfigLayersStore, type SettingsProject } from "../../workbench/config-layers-store";
import { searchSettings, settingsSearchEntries, type SettingsSearchEntry } from "./settings-search";
import { CORE_PAGE_DESCRIPTIONS, CORE_PAGE_TITLES, CORE_SETTINGS_PAGES, extensionOfPage, extensionPage, parentSettingsPage, parseSettingsTarget, runtimeOfPage, runtimePage, settingsNavGroupOpen, settingsNavGroups, settingsTarget, type SettingsNavGroup, type SettingsNavGroupAlias } from "./settings-nav";
import { SettingsLevelsProvider } from "./settings-layout";
import { SettingsPageActionSlot } from "./page-action";
import { SettingsRegistryContext } from "./page-sections";
import { SettingsPageHead, type SettingsCrumb } from "./page-head";
import { scopeMachines, scopeProjects } from "./settings-scope";
import { extensionCatalog, needsAttention } from "./extension-catalog";
import { AboutPage } from "./AboutPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { GeneralPage } from "./GeneralPage";
import { ThreadsPage } from "./ThreadsPage";
import { ExtensionPage, ExtensionPageFallback, useExtensionSources } from "./ExtensionPage";
import { ExtensionsPage } from "./ExtensionsPage";
import { InspectorPage } from "./InspectorPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { RuntimesPage } from "./RuntimesPage";
import { inRuntimeOrder } from "../runtime-order";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
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
  runtimes: Bot,
  threads: ListTree,
  connections: MonitorSmartphone,
  extensions: Blocks,
  inspector: Activity,
  about: Info,
};

interface NavItem {
  id: string;
  label: string;
  group: SettingsNavGroup | SettingsNavGroupAlias | undefined;
  order: number | undefined;
  Icon: PanelIconComponent | undefined;
  useSummary?: (() => string | undefined) | undefined;
}

/** A page's value beside its row on a phone (design 1s): "2 online", "Pi default". */
function NavValue({ use }: { use(): string | undefined }) {
  const value = use();
  return value ? <small className="settings-nav-value">{value}</small> : null;
}

const noSubscription = () => () => undefined;

/** The pages of core that draw the sections other extensions attach to them. */
const CORE_SECTION_PAGES: readonly string[] = ["connections", "extensions", "extension", "runtimes", "general", "threads", "inspector"];
/** The install form's row, which says a package installer is attached to Extensions, and the row beside it a project's trust is answered on. */
const INSTALL_ROW = "setting-packages-source";
const TRUST_ROW = "setting-packages-trust";

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
  threads = [],
  onSetPage,
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
  /** The window's threads: those of other machines tell which projects are not this machine's. */
  threads?: readonly UiSession[];
  onSetPage(page: string): void;
  onClose(): void;
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
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
  const catalogs = useRuntimeCatalogs(true, false);
  const { readOnly } = useHostCapabilities();
  const appPages = useAppPageStore();
  // Past an app page Settings was opened over, too.
  const onBackToThread = () => { onClose(); appPages?.close(); };
  const { disabledExtensions } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const [levels] = useState(() => new ConfigLayersStore(client, () => void preferences.syncFromHost()));
  const project = currentProject(snapshot, projects);
  useEffect(() => { levels.setProject(project); }, [levels, project?.workspaceId, project?.label]);
  // Another machine's refusal or silence is said once: its values would otherwise just snap back.
  const levelsError = useSyncExternalStore(levels.subscribe, () => (levels.getSnapshot().machine ? levels.getSnapshot().error : undefined));
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (levelsError) onNotify(levelsError, "error"); }, [levelsError]);
  // A push that changed a file, or the palette's theme, moves the levels too.
  useEffect(() => {
    void levels.refresh();
    return preferences.subscribe(() => void levels.refresh());
  }, [levels, preferences]);

  const { page: parsedPage, anchor } = parseSettingsTarget(target);
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
  // Pages extensions own. Core keeps General, Runtimes, Keybindings and
  // Diagnostics, so safe mode still has a model picker and a way to see what is loaded.
  const contributions = registry.getSettingsPages();
  // A page about a runtime is that runtime's card on Runtimes, not a page of its own; its old id opens the runtime.
  const cards = inRuntimeOrder(contributions.filter((entry) => entry.runtime), (entry) => entry.runtime, snapshot?.runtimeBackends);
  const cardRuntime = cards.find((card) => card.id === parsedPage)?.runtime;
  const pages = contributions.filter((entry) => !entry.runtime && !entry.standalone);
  // A page an extension gave up for a section of another page (`replaces`) opens that page, or the extension's own where that page is not there.
  const replacing = cardRuntime ? undefined : registry.settingsSectionReplacing(parsedPage);
  const replacedBy = replacing && (CORE_SECTION_PAGES.includes(replacing.page) || pages.some((entry) => entry.id === replacing.page) ? replacing.page : extensionPage(replacing.extensionId));
  const requested = cardRuntime ? runtimePage(cardRuntime) : replacedBy ?? parsedPage;
  const contributed = contributions.find((entry) => !entry.runtime && entry.id === requested);
  const isCore = requested in CORE_PAGE_TITLES;
  // An extension's id alone is the older link to its page.
  const extensionId = extensionOfPage(requested) ?? (!isCore && !contributed && catalog.some((entry) => entry.id === requested) ? requested : undefined);
  const page = extensionId ? extensionPage(extensionId) : requested;
  const extension = extensionId ? catalog.find((entry) => entry.id === extensionId) : undefined;
  // Sections of a page that is not there are drawn on their own extension's page.
  const sectionHosts = new Set<string>([...CORE_SECTION_PAGES, ...pages.map((entry) => entry.id)]);
  const orphanSections = registry.getSettingsSections().filter((section) => !sectionHosts.has(section.page));
  const trustRow = registry.getSettingsSections("extensions").some((section) => section.rows?.some((row) => row.id === INSTALL_ROW));
  const runtimeKind = runtimeOfPage(page);
  const runtimeName = runtimeKind ? snapshot?.runtimeBackends?.find((backend) => backend.kind === runtimeKind)?.label ?? runtimeKind : undefined;
  const pageLabel = runtimeName ?? (extensionId ? extension?.name ?? "Extension"
    : CORE_PAGE_TITLES[page as keyof typeof CORE_PAGE_TITLES] ?? contributed?.label ?? "Settings");
  const parent = parentSettingsPage(page);
  // Other machines' own settings: General only, where every row is a setting or says it is not one.
  const environments = usePlatform().environments;
  const environmentList = useSyncExternalStore(environments?.subscribe ?? noSubscription, () => environments?.getSnapshot());
  const machines = page === "general" && !environments?.shownElsewhere ? scopeMachines(environmentList?.environments) : [];
  // A phone's detail of a runtime has its name in the bar; the page's own sentence belongs to the list.
  const pageDescription = extensionId || (runtimeKind && stacked) ? undefined
    : CORE_PAGE_DESCRIPTIONS[(runtimeKind ? "runtimes" : page) as keyof typeof CORE_PAGE_DESCRIPTIONS] ?? contributed?.description;
  const parentLabel = parent ? CORE_PAGE_TITLES[parent as keyof typeof CORE_PAGE_TITLES] ?? parent : undefined;
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  // An extension's page draws its own title beside its mark.
  const ownTitle = Boolean(extensionId && extension);
  const crumbs: SettingsCrumb[] = parent && !runtimeKind ? [
    { label: "Settings", open: () => onSetPage("general") },
    { label: parentLabel!, open: () => onSetPage(parent) },
  ] : [];
  // What a page is applied to is chosen per visit: leaving it puts the scope back on this machine.
  // Choosing another runtime in the list is not leaving Runtimes.
  const scopePage = runtimeKind ? "runtimes" : page;
  useEffect(() => { levels.edit("host"); }, [levels, scopePage]);

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
    // A runtime's card is found like a page: its id opens that runtime on Runtimes.
    pages: [...pages, ...cards].map((entry) => ({ id: entry.id, label: entry.label, description: entry.description, keywords: entry.keywords, extensionName: entry.extensionName, rows: entry.rows })),
    sections: registry.getSettingsSections(),
    extensions: catalog.map((entry) => ({ id: entry.id, name: entry.name, core: entry.locked, options: entry.summary?.options ?? [] })),
    keybindings: registry.getKeybindings().map((binding) => ({
      commandId: binding.commandId,
      keys: binding.keys,
      label: binding.label,
      commandLabel: commands.find((command) => command.id === binding.commandId)?.label,
    })),
  }), search) : [];
  // Results can shrink without a keystroke (a contribution unloads); keep the highlight on a row.
  const active = Math.min(activeResult, Math.max(found.length - 1, 0));
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
    if (onViewChange) onViewChange("page"); else setOwnShowingPage(true);
    onSetPage(page);
  }, [anchor, onSetPage, onViewChange, page]);
  // A page by an older name, or a runtime's card by its kit's id, is shown and kept under the page it became.
  const renamed = requested !== (target.split("#", 1)[0] || "general");
  useEffect(() => {
    if (renamed && !anchor) onSetPage(page);
  }, [renamed, anchor, onSetPage, page]);

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
      // A row under Connections' Advanced is folded away.
      const fold = row.closest("details");
      if (fold) fold.open = true;
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

  // Every page starts at the top.
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [page]);

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
      // The find chord also works from a field; a chord recorder keeps it (T3 #17859).
      const recording = event.target instanceof Element && event.target.closest(`[${KEYBINDING_CAPTURE_ATTRIBUTE}]`) !== null;
      const find = event.key.toLowerCase() === "f" && !event.altKey && !event.shiftKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      if (event.isComposing || (recording && find)) return;
      if (find || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
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

  const runtimeLabel = snapshot?.runtimeBackends?.find((backend) => backend.kind === effectiveNewThreadRuntime(preferences.getSnapshot().newThreadRuntime, snapshot, catalogs))?.label;
  const navItems: NavItem[] = [
    ...CORE_SETTINGS_PAGES
      // A phone has no keys to bind (design 1s).
      .filter((entry) => !(nav && entry.id === "keybindings"))
      .map((entry) => ({ id: entry.id, label: entry.label, group: entry.group, order: entry.order, Icon: CORE_ICONS[entry.id], ...(entry.id === "runtimes" && runtimeLabel ? { useSummary: () => `${runtimeLabel} default` } : {}) })),
    ...pages.map((entry) => ({ id: entry.id, label: entry.label, group: entry.group, order: entry.order, Icon: entry.Icon, useSummary: entry.useSummary })),
  ];
  const attention = catalog.filter(needsAttention).length;
  const iconOf = (id: string): PanelIconComponent | undefined => CORE_ICONS[id] ?? (extensionOfPage(id) ? Blocks : runtimeOfPage(id) || cards.some((card) => card.id === id) ? Bot : pages.find((entry) => entry.id === id)?.Icon);
  const activeNav = parent ?? page;
  // A folding group as the user left it, also last time Settings was open; unset, it follows the page on screen.
  const [toggledGroups, setToggledGroups] = useState<Partial<Record<SettingsNavGroup, boolean>>>(navFolds);
  // The pages of the Diagnostics group stand at the foot, above About Tau.
  const navGroupList = settingsNavGroups(navItems);
  const footerItems = navGroupList.find((group) => group.id === "diagnostics")?.items ?? [];
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
      {stacked && item.useSummary ? <NavValue use={item.useSummary} /> : null}
      {stacked ? <ChevronRight size={14} className="settings-nav-chevron" aria-hidden /> : null}
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
      <SettingsRegistryContext.Provider value={registry}>
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
                aria-controls={found.length > 0 ? "settings-search-results" : undefined}
                aria-activedescendant={found[active] ? `settings-search-result-${active}` : undefined}
                onChange={(event) => { setSearch(event.target.value); setActiveResult(0); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); clearSearch(); return; }
                  if (found.length === 0) return;
                  if (event.key === "ArrowDown") { event.preventDefault(); setActiveResult((active + 1) % found.length); }
                  if (event.key === "ArrowUp") { event.preventDefault(); setActiveResult((active - 1 + found.length) % found.length); }
                  if (event.key === "Enter") { event.preventDefault(); const entry = found[active]; if (entry) openFound(entry); }
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
                      aria-selected={index === active}
                      className={`settings-search-result ${index === active ? "active" : ""}`}
                      onMouseMove={() => setActiveResult(index)}
                      onClick={() => openFound(entry)}
                    >
                      <PanelIcon Icon={iconOf(entry.page)} size={14} />
                      <span><span>{entry.label}</span><small>{entry.description ?? entry.section}</small></span>
                    </button>
                  ))}
                </div> : <p className="settings-search-empty" role="status">No setting matches “{search.trim()}”.</p>}
              </> : navGroupList.filter((group) => group.id !== "diagnostics").map((group) => {
                const open = settingsNavGroupOpen(group, activeNav, toggledGroups);
                return (
                  <div key={group.id} className="settings-nav-group" role="group" aria-label={group.label} data-folds={group.folds ? "" : undefined}>
                    {group.folds ? (
                      <h2 className="settings-nav-heading">
                        <button type="button" className="settings-nav-fold" aria-expanded={open} onClick={() => { navFolds = { ...navFolds, [group.id]: !open || undefined }; setToggledGroups((current) => ({ ...current, [group.id]: !open })); }}>
                          <ChevronRight size={12} aria-hidden /><span>{group.label}</span>
                        </button>
                      </h2>
                    ) : <h2 className="settings-nav-heading">{group.label}</h2>}
                    {open ? group.items.map(navButton) : null}
                  </div>
                );
              })}
            </div>
            <div className="settings-nav-footer">
              {footerItems.map((item) => (
                <button key={item.id} type="button" className={`settings-about-link ${activeNav === item.id ? "active" : ""}`} aria-current={activeNav === item.id ? "page" : undefined} onClick={() => openPage(item.id)}>
                  <PanelIcon Icon={item.Icon} size={15} /><span>{item.label}</span>{stacked ? <ChevronRight size={14} className="settings-nav-chevron" aria-hidden /> : null}
                </button>
              ))}
              <button type="button" className={`settings-about-link ${page === "about" ? "active" : ""}`} aria-current={page === "about" ? "page" : undefined} onClick={() => openPage("about")}>
                <Info size={15} /><span>About Tau</span>{version ? <small>{version}</small> : null}{stacked ? <ChevronRight size={14} className="settings-nav-chevron" aria-hidden /> : null}
              </button>
              {nav ? <p className="settings-nav-note">Keys and sign-ins live on your machines; the phone only connects to them.</p> : null}
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
                  title={stacked || ownTitle ? undefined : page === "about" ? "Tau" : runtimeKind ? CORE_PAGE_TITLES.runtimes : pageLabel}
                  description={page === "about" || page === "general" ? undefined : pageDescription}
                  crumbs={stacked ? [] : crumbs}
                  scope={{ projects: scopeProjects(projects, threads, project), current: project, machines }}
                  actionSlot={setActionSlot}
                />
                {readOnly ? <p className="settings-read-only" role="note">This device is paired Read only: the machine keeps its settings as they are. Theme and layout stay on this device.</p> : null}
                <SettingsPageActionSlot.Provider value={actionSlot}>
                  {page === "general" ? (
                    <GeneralPage themeHere={!pages.some((entry) => entry.keywords?.includes("theme"))} sections={registry.getSettingsSections("general")} onNotify={onNotify} detailShortcut={registry.keybindingLabel("runtime.transcript-detail")} />
                  ) : page === "threads" ? (
                    <ThreadsPage sections={[...registry.getSettingsSections("general"), ...registry.getSettingsSections("threads")]} onNotify={onNotify} />
                  ) : page === "runtimes" || runtimeKind ? (
                    <RuntimesPage
                      snapshot={snapshot}
                      cards={cards}
                      sections={registry.getSettingsSections("runtimes")}
                      selected={runtimeKind}
                      stacked={stacked}
                      onSelect={(kind) => openPage(kind ? runtimePage(kind) : "runtimes")}
                      onOpen={openPage}
                      onNotify={onNotify}
                    />
                  ) : page === "keybindings" ? (
                    <KeybindingsPage key={keybindingFilter.seq} registry={registry} initialFilter={keybindingFilter.filter} onNotify={onNotify} onOpen={openPage} />
                  ) : contributed ? (
                    <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} onOpenSettings={openPage} />
                  ) : page === "extensions" ? (
                    <ExtensionsPage
                      entries={sources.loading && !sources.inspection && snapshot?.cwd ? [] : catalog}
                      registry={registry}
                      loading={sources.loading}
                      error={sources.error}
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
                        sections={[...extensionSections, ...orphanSections.filter((section) => section.extensionId === extensionId)]}
                        trustPage={trustRow ? settingsTarget("extensions", TRUST_ROW) : undefined}
                        onOpen={openPage}
                        onChanged={() => setAnswered((count) => count + 1)}
                        onNotify={onNotify}
                        onHostHalves={sources.setHostHalves}
                      />
                    ) : <ExtensionPageFallback loading={sources.loading} onBack={() => onSetPage("extensions")} />
                  ) : page === "inspector" ? (
                    <InspectorPage registry={registry} cwd={snapshot?.cwd} onNotify={onNotify} />
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
      </SettingsRegistryContext.Provider>
    </SettingsLevelsProvider>
  );
}
