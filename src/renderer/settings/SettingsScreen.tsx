import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Command, Cpu, Folder, Info, Monitor, MonitorSmartphone, Plus, Puzzle, Search, Server, Sliders, X } from "lucide-react";
import type { HostSnapshot, UiProject } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { usePreferences } from "../renderer-services-context";
import { useHostClient } from "../host-client-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { Menu } from "../components/Menu";
import { PanelIcon } from "../components/PanelIcon";
import { PiSettingsPage } from "../components/PiSettingsPage";
import { WindowControlsInset } from "../components/WindowControlsInset";
import { isMacPlatform } from "../keybindings";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "../keybinding-context";
import { ConfigLayersStore, type SettingsProject } from "../../workbench/config-layers-store";
import { searchSettings, settingsSearchEntries, type SettingsSearchEntry } from "./settings-search";
import { SettingsLevelsProvider, useSettingsLevels } from "./settings-layout";
import { AboutPage } from "./AboutPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { DefaultsPage } from "./DefaultsPage";
import { ExtensionPage, useAwaitingApproval } from "./ExtensionPage";
import { InspectorPage } from "./InspectorPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { ProvidersPage, providerCardId } from "./ProvidersPage";
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

/** The last crumb: the level a change on this page is written to. */
function ScopeCrumb({ projects, current }: { projects: readonly UiProject[]; current?: SettingsProject }) {
  const { store, snapshot } = useSettingsLevels();
  const [open, setOpen] = useState(false);
  const choices = useMemo(() => {
    const list: SettingsProject[] = current ? [current] : [];
    for (const project of projects) {
      const workspaceId = project.workspaceId ?? project.path;
      if (current && (project.workspaceId === current.workspaceId || project.path === current.workspaceId || project.path === current.path)) continue;
      if (!list.some((entry) => entry.workspaceId === workspaceId)) list.push({ workspaceId, label: project.name || projectName(project.path) });
    }
    return list;
  }, [current, projects]);
  const editingProject = snapshot.editing === "project" ? snapshot.project : undefined;
  return (
    <li className="settings-crumb settings-scope">
      <button
        type="button"
        className={editingProject ? "narrowed" : ""}
        aria-label={`Settings apply to ${editingProject ? editingProject.label : "this machine"}. Change where they apply`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {editingProject ? <Folder size={13} /> : <Monitor size={13} />}
        <span>{editingProject ? editingProject.label : "This machine"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <Menu
          align="left"
          sections={[
            { items: [{ id: "host", label: "This machine", description: "Every project without its own value", selected: !editingProject, icon: <Monitor size={13} /> }] },
            {
              heading: "Override for a project",
              items: choices.map((project) => ({
                id: `project:${project.workspaceId}`,
                label: project.label,
                icon: <Folder size={13} />,
                selected: editingProject?.workspaceId === project.workspaceId,
              })),
            },
          ]}
          onSelect={(id) => {
            if (id === "host") store.edit("host");
            else store.edit("project", choices.find((project) => `project:${project.workspaceId}` === id));
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </li>
  );
}

const CORE_PAGE_LABELS: Record<string, string> = {
  defaults: "Defaults",
  pi: "Pi",
  providers: "Providers",
  keybindings: "Keybindings",
  connections: "Connections",
  inspector: "Inspector",
  about: "About",
};

/**
 * Settings as a page of its own: it takes the whole window, the way T3 Code's
 * settings route does. A navigation column with the search on the left, a top
 * bar with the page and the level a change is written to, the page below at a
 * readable width. Escape, Back and ⌘, return to the workbench.
 */
export function SettingsScreen({
  page,
  snapshot,
  registry,
  projects = [],
  onSetPage,
  onSetModel,
  onSetThinking,
  onClose,
  onNotify,
  stacked = false,
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
}) {
  const preferences = usePreferences();
  const client = useHostClient();
  const { readOnly } = useHostCapabilities();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [levels] = useState(() => new ConfigLayersStore(client, () => void preferences.syncFromHost()));
  const project = currentProject(snapshot, projects);
  useEffect(() => { levels.setProject(project); }, [levels, project?.workspaceId, project?.label]);
  // A push that changed a file, or the palette's theme, moves the levels too.
  useEffect(() => {
    void levels.refresh();
    return preferences.subscribe(() => void levels.refresh());
  }, [levels, preferences]);

  const loaded = registry.getExtensionSummaries();
  const [answered, setAnswered] = useState(0);
  const awaiting = useAwaitingApproval(snapshot?.cwd, loaded, answered);
  const summaries = [...loaded, ...awaiting];
  const active = summaries.find((summary) => summary.id === page);
  // Pages extensions own. Core keeps Defaults, Keybindings and the Inspector,
  // so safe mode still has a model picker and a way to see what is loaded.
  const contributions = registry.getSettingsPages();
  // A page about a runtime is a card on Providers, not a page of its own.
  const providers = inRuntimeOrder(contributions.filter((entry) => entry.runtime), (entry) => entry.runtime, snapshot?.runtimeBackends);
  const pages = contributions.filter((entry) => !entry.runtime && !entry.standalone);
  const contributed = contributions.find((entry) => !entry.runtime && entry.id === page);
  const installer = pages.find((entry) => entry.id === "packages");
  const onProviders = providers.length > 0 && (page === "providers" || providers.some((card) => card.id === page));
  const pageLabel = onProviders ? "Providers" : CORE_PAGE_LABELS[page] ?? contributed?.label ?? active?.name ?? "Settings";
  // Providers lists each runtime's models, which a project may arrange its own way.
  const pageScope = page === "defaults" || onProviders ? "both" : contributed?.scope ?? "host";
  const showScope = pageScope !== "host";
  // A page without project rows edits this machine; leaving one puts the scope back.
  useEffect(() => { if (!showScope) levels.edit("host"); }, [levels, showScope]);

  const [showingPage, setShowingPage] = useState(!stacked);
  // What the section list opens; stacked, it also turns from the list to the page.
  const openPage = (id: string) => { onSetPage(id); setShowingPage(true); };
  const [search, setSearch] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [target, setTarget] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  // What a keybinding result filtered the Keybindings page to; a new result remounts it.
  const [keybindingFilter, setKeybindingFilter] = useState<{ filter: string; seq: number }>({ filter: "", seq: 0 });
  const commands = registry.getCommands();
  const found = search.trim() ? searchSettings(settingsSearchEntries({
    pages: pages.map((entry) => ({ id: entry.id, label: entry.label, keywords: entry.keywords, extensionName: entry.extensionName })),
    extensions: summaries,
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
    setTarget(entry.target);
    openPage(entry.page);
  };

  // A search result that names a row scrolls to it once its page is drawn.
  useEffect(() => {
    if (!target) return;
    const row = document.getElementById(target);
    if (!row) return;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
    row.classList.remove("settings-target-pulse");
    void row.offsetWidth;
    row.classList.add("settings-target-pulse");
    setTarget(undefined);
  }, [page, target]);

  const scrollRef = useRef<HTMLDivElement>(null);
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

  // The extension lists fold away (28 entries on a stock install); the one holding the open page, or one awaiting approval, starts open.
  const [groupsOpen, setGroupsOpen] = useState<Readonly<Record<string, boolean>>>({});
  const navGroup = (id: string, label: string, entries: typeof summaries, render: (summary: (typeof summaries)[number]) => React.ReactNode) => {
    if (entries.length === 0) return null;
    const open = groupsOpen[id] ?? entries.some((summary) => summary.id === page || awaiting.includes(summary));
    return <>
      <button type="button" className="settings-nav-heading" aria-expanded={open} onClick={() => setGroupsOpen((current) => ({ ...current, [id]: !open }))}>
        <span>{label} · {entries.length}</span>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open ? entries.map(render) : null}
    </>;
  };

  const navButton = (id: string, label: string, icon: React.ReactNode, onClick = () => openPage(id), activeWhen = page === id) => (
    <button key={id} className={activeWhen ? "active" : ""} aria-current={activeWhen ? "page" : undefined} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );

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
              <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} />
            </div>
          </div>
        </main>
      </div>
    </SettingsLevelsProvider>
  );

  return (
    <SettingsLevelsProvider store={levels}>
      <div className={stacked ? "settings-screen stacked" : "settings-screen"} data-view={stacked ? (showingPage ? "page" : "sections") : undefined} role="dialog" aria-modal="true" aria-label="Settings" data-preview-overlay="">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-header">{stacked ? <>
            <h1>Settings</h1>
            {showingPage ? null : <button type="button" className="settings-sections-back" aria-label="Close settings" onClick={onClose}><X size={18} /></button>}
          </> : <WindowControlsInset />}</div>
          <label className="settings-nav-search">
            <Search size={14} />
            <input
              ref={searchRef}
              type="search"
              value={search}
              placeholder="Search"
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
                    id={`settings-search-result-${index}`}
                    role="option"
                    aria-selected={index === activeResult}
                    className={`settings-search-result ${index === activeResult ? "active" : ""}`}
                    onMouseMove={() => setActiveResult(index)}
                    onClick={() => openFound(entry)}
                  >
                    <span>{entry.label}</span>
                    <small>{entry.section}</small>
                  </button>
                ))}
              </div> : <p className="settings-search-empty" role="status">No setting matches “{search.trim()}”.</p>}
            </> : <>
              {navButton("defaults", "Defaults", <Sliders size={15} />)}
              {navButton("pi", "Pi", <Cpu size={15} />)}
              {providers.length > 0 ? navButton("providers", "Providers", <Server size={15} />, undefined, onProviders) : null}
              {navButton("keybindings", "Keybindings", <Command size={15} />, () => { setKeybindingFilter((current) => ({ filter: "", seq: current.seq + 1 })); openPage("keybindings"); })}
              {pages.map((entry) => navButton(entry.id, entry.label, <PanelIcon Icon={entry.Icon} size={15} />))}
              {navButton("connections", "Connections", <MonitorSmartphone size={15} />)}
              {navButton("inspector", "Inspector", <Puzzle size={15} />)}
              {navButton("about", "About", <Info size={15} />)}
              {navGroup("extensions", "Extensions", summaries.filter((summary) => !summary.core), (summary) => (
                <button
                  key={summary.id}
                  className={`${page === summary.id ? "active" : ""} ${summary.active ? "" : "off"}`}
                  aria-current={page === summary.id ? "page" : undefined}
                  onClick={() => openPage(summary.id)}
                >
                  <span className={`extension-dot ${summary.active ? "" : "off"}`} />
                  <span>{summary.name}</span>
                  {summary.active ? null : <small>off</small>}
                </button>
              ))}
              {navGroup("core", "Core", summaries.filter((summary) => summary.core), (summary) => (
                <button key={summary.id} className={page === summary.id ? "active" : ""} aria-current={page === summary.id ? "page" : undefined} onClick={() => openPage(summary.id)}>
                  <span className="extension-dot" />
                  <span>{summary.name}</span>
                </button>
              ))}
            </>}
          </div>
          <div className="settings-nav-footer">
            {installer ? (
              <button className="install-extension" onClick={() => openPage(installer.id)}>
                <Plus size={13} /> Install extension…
              </button>
            ) : null}
            <button className="settings-back" onClick={onClose} title={`Back (Esc, ${isMacPlatform() ? "⌘," : "Ctrl+,"})`}>
              <ArrowLeft size={15} /><span>Back</span>
            </button>
          </div>
        </nav>

        <main className="settings-main">
          <header className="settings-topbar">
            {stacked ? <button type="button" className="settings-sections-back" aria-label="All settings" onClick={() => setShowingPage(false)}><ChevronLeft size={18} /></button> : null}
            <nav aria-label="Settings breadcrumb">
              <ol>
                <li className="settings-crumb"><button type="button" onClick={() => (stacked ? setShowingPage(false) : onSetPage("defaults"))}>Settings</button></li>
                <li className="settings-crumb-separator" aria-hidden>/</li>
                <li className="settings-crumb current" aria-current="page"><h1>{pageLabel}</h1></li>
                {showScope ? <>
                  <li className="settings-crumb-separator" aria-hidden>/</li>
                  <ScopeCrumb projects={projects} current={project} />
                </> : null}
              </ol>
            </nav>
            {stacked && showingPage ? <button type="button" className="settings-sections-back settings-close" aria-label="Close settings" onClick={onClose}><X size={18} /></button> : null}
          </header>
          <div className="settings-scroll" ref={scrollRef}>
            <div className="settings-content" data-page={page}>
              {readOnly ? <p className="settings-read-only" role="note">This device is paired Read only: the host keeps its settings as they are. Theme and layout stay on this device.</p> : null}
              {page === "defaults" ? (
                <DefaultsPage snapshot={snapshot} onSetModel={onSetModel} onSetThinking={onSetThinking} />
              ) : page === "keybindings" ? (
                <KeybindingsPage key={keybindingFilter.seq} registry={registry} initialFilter={keybindingFilter.filter} onNotify={onNotify} />
              ) : page === "pi" ? (
                <PiSettingsPage snapshot={snapshot} onNotify={onNotify} />
              ) : onProviders ? (
                <ProvidersPage cards={providers} backends={snapshot?.runtimeBackends} cwd={snapshot?.cwd} onNotify={onNotify} />
              ) : contributed ? (
                <contributed.Component cwd={snapshot?.cwd} onNotify={onNotify} />
              ) : page === "inspector" ? (
                <InspectorPage registry={registry} cwd={snapshot?.cwd} />
              ) : page === "connections" ? (
                <ConnectionsPage onNotify={onNotify} sections={registry.getSettingsSections("connections")} />
              ) : page === "about" ? (
                <AboutPage />
              ) : active ? (
                <ExtensionPage summary={active} registry={registry} models={snapshot?.completionModels ?? snapshot?.models ?? []} cwd={snapshot?.cwd} onChanged={() => { setAnswered((count) => count + 1); onSetPage(active.id); }} onNotify={onNotify} />
              ) : (
                <div className="settings-page"><p className="lede">This page is gone; its extension may have been turned off.</p></div>
              )}
            </div>
          </div>
        </main>
      </div>
    </SettingsLevelsProvider>
  );
}
