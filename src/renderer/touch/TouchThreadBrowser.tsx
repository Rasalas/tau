import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronLeft, Ellipsis, Folder, Info, ListFilter, MonitorSmartphone, Plus, Search, Settings, X } from "lucide-react";
import type { UiProject } from "../../shared/contracts";
import { errorMessage } from "../../workbench/error-message";
import { rootLast } from "../../workbench/new-thread-project";
import { threadListGroups, type ThreadSupervisionRow } from "../../workbench/thread-supervision";
import { useClientEnvironment } from "../client-environment";
import { ProjectIcon } from "../components/ProjectIcon";
import { TauMark } from "../components/TauMark";
import type { ExtensionRegistry, PageContribution, ThreadListEntry, WorkbenchActions } from "../extension-system";
import { useOpenPage } from "../app-page-context";
import { Region } from "../components/Regions";
import { Popover } from "../components/ui/Dialog";
import { tooltipProps } from "../components/ui/Tooltip";
import { useHostCapabilities } from "../use-host-capabilities";
import { useThreadStore } from "../workbench-context";
import { Sheet } from "../deferred-surfaces";
import { TouchThreadList, type TouchThreadListProps } from "./TouchThreadList";
import { useThreadListSources } from "./thread-list-sources";
import "./touch.css";

export { TouchThreadList };

const SEARCH_RESULTS = 20;

/**
 * A phone's top bar: the mark, kits' bars, search and project-filter sheets,
 * then More for Settings and shell actions. New thread floats over the list.
 * A tablet keeps its title and New thread in the sidebar's header.
 */
export function TouchThreadBrowser({ variant, nav, onNewThread, onOpenSettings, projects = [], onProjectChange, ...list }: TouchThreadListProps & {
  variant: "home" | "sidebar";
  /** The bottom navigation, under a phone's list. */
  nav?: ReactNode;
  onNewThread(): void;
  onOpenSettings(page?: string): void;
  projects?: readonly UiProject[];
  onProjectChange?(project: UiProject | undefined): void;
}) {
  const surface = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<"search" | "menu">();
  const screen = variant === "home";
  const shell = useClientEnvironment().shell;
  // A Read-only device could never send a new thread's first message.
  const { readOnly } = useHostCapabilities();

  // What kits put over the list: another machine's state.
  const head = <Region registry={list.registry} placement="thread-list-head" actions={list.actions} />;
  const filter = onProjectChange ? <ProjectFilter projects={projects} project={list.project} onChange={onProjectChange} alwaysShown={screen} /> : null;
  const toggleSearch = () => setPopover(popover === "search" ? undefined : "search");
  const search = <button ref={searchButton} type="button" className="touch-icon-button" aria-label="Search threads" aria-haspopup="dialog" aria-expanded={popover === "search"} {...tooltipProps("Search threads", { side: "bottom" })} onClick={toggleSearch}><Search size={20} /></button>;
  const more = <button ref={menuButton} type="button" className="touch-icon-button" aria-label="More" aria-haspopup="menu" aria-expanded={popover === "menu"} {...tooltipProps("More", { side: "bottom" })} onClick={() => setPopover(popover === "menu" ? undefined : "menu")}><Ellipsis size={20} /></button>;
  const header = screen ? <header className="touch-home-head">
    <div className="touch-browser-header brand-head">
      <TauMark className="touch-brand-mark" />
      <span className="spacer" />
      <Region registry={list.registry} placement="thread-list-title" actions={list.actions} />
      <div className="touch-header-actions">{search}{filter}{more}</div>
    </div>
  </header> : <header className="touch-browser-header">
    <strong>Threads</strong>
    <span className="spacer" />
    {search}
    {filter}
    {more}
    {readOnly ? null : <button type="button" className="touch-icon-button" aria-label="New thread" {...tooltipProps("New thread", { side: "bottom" })} onClick={onNewThread}><Plus size={20} /></button>}
  </header>;

  const searchContent = <ThreadSearch registry={list.registry} onOpen={(row, entry) => { setPopover(undefined); if (entry) entry.open(list.actions); else list.onOpen(row); }} />;
  const popovers = <>
    {popover === "search" ? screen ? <Sheet title="Search threads" className="touch-search" onClose={() => setPopover(undefined)}>
      {searchContent}
    </Sheet> : <Popover anchor={searchButton} side="bottom" align="end" label="Search threads" className="touch-popover touch-search" onClose={() => setPopover(undefined)}>
      {searchContent}
    </Popover> : null}
    {popover === "menu" ? <Popover anchor={menuButton} side="bottom" align="end" label="More" className="touch-popover touch-menu" onClose={() => setPopover(undefined)}>
      <div role="menu" aria-label="More">
        {/* Which host a native shell is on: said here, not over the list. */}
        {shell?.hostLabel ? <p className="touch-menu-context">On {shell.hostLabel}</p> : null}
        <button type="button" role="menuitem" onClick={() => { setPopover(undefined); onOpenSettings(); }}><Settings size={17} />Settings</button>
        <button type="button" role="menuitem" onClick={() => { setPopover(undefined); onOpenSettings("about"); }}><Info size={17} />About Tau</button>
        <button type="button" role="menuitem" onClick={() => { setPopover(undefined); onOpenSettings("connections"); }}><MonitorSmartphone size={17} />Connections</button>
        {shell?.actions?.map((action) => <button key={action.id} type="button" role="menuitem" onClick={() => { setPopover(undefined); action.run(); }}>{action.Icon ? <action.Icon size={17} /> : null}{action.label}</button>)}
      </div>
    </Popover> : null}
  </>;

  if (screen) return <section ref={surface} className={`touch-browser screen home${nav ? " with-nav" : ""}`} aria-label="Threads">
    {header}
    <div className="touch-browser-body">
      {head}
      <TouchThreadList {...list} />
      {/* The floating button is the empty list's next step too. */}
      {readOnly ? null : <button type="button" className="touch-fab" aria-label="New thread" onClick={onNewThread}><Plus size={28} /></button>}
    </div>
    {nav}
    {popovers}
  </section>;
  return <nav ref={surface} className="touch-browser sidebar" aria-label="Thread list">
    {header}
    {head}
    <TouchThreadList {...list} onNewThread={onNewThread} />
    <TabletFooter registry={list.registry} actions={list.actions} onOpenSettings={onOpenSettings} />
    {popovers}
  </nav>;
}

const noPageBadge = () => undefined;
const noPageSummary = () => undefined;

function TabletSummaryButton({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  const summary = (page.useSummary ?? noPageSummary)();
  if (!summary) return <TabletPageButton page={page} actions={actions} />;
  return <button type="button" className="touch-page-summary" aria-label={`${page.label}: ${summary.hint ?? summary.text}`} {...tooltipProps(summary.hint ?? page.label, { side: "top" })} onClick={() => actions.openPage?.(page.id)}>{summary.short ?? summary.text}</button>;
}

function TabletPageSummary({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  return page.Summary ? <page.Summary actions={actions} /> : <TabletSummaryButton page={page} actions={actions} />;
}

function TabletPageButton({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  const count = (page.useBadge ?? noPageBadge)();
  const label = count ? `${page.label}, ${count}` : page.label;
  return <button type="button" className="touch-icon-button" aria-label={label} {...tooltipProps(label, { side: "top" })} onClick={() => actions.openPage?.(page.id)}>
    {page.Icon ? <page.Icon size={19} /> : page.label.slice(0, 1)}
    {count ? <span className="page-badge">{count > 99 ? "99+" : count}</span> : null}
  </button>;
}

function TabletFooter({ registry, actions, onOpenSettings }: Pick<TouchThreadListProps, "registry" | "actions"> & { onOpenSettings(page?: string): void }) {
  useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const { readOnly } = useHostCapabilities();
  const pages = registry.getPages();
  const open = useOpenPage();
  if (open) return <div className="touch-sidebar-footer" role="group" aria-label="Sidebar controls">
    <button type="button" className="touch-sidebar-back" onClick={() => actions.closePage?.()}><ChevronLeft size={19} />Back to thread</button>
  </div>;
  return <div className="touch-sidebar-footer" role="group" aria-label="Sidebar controls">
    {pages.filter((page) => !page.Summary && !page.useSummary).map((page) => <TabletPageButton key={page.id} page={page} actions={actions} />)}
    {registry.getCommandsFor("sidebar-footer").map((command) => <button key={command.id} type="button" className="touch-icon-button" aria-label={command.label} disabled={readOnly && command.access !== "read"} onClick={() => { void registry.executeCommand(command.id, actions).catch((error) => actions.notify(errorMessage(error), "error")); }}>
      {command.Icon ? <command.Icon size={19} /> : command.label}
    </button>)}
    <span className="spacer" />
    {pages.filter((page) => page.Summary || page.useSummary).map((page) => <TabletPageSummary key={page.id} page={page} actions={actions} />)}
    <button type="button" className="touch-icon-button" aria-label="Settings" {...tooltipProps("Settings", { side: "top" })} onClick={() => onOpenSettings()}><Settings size={19} /></button>
  </div>;
}

/**
 * Which project's threads the list shows: an icon in the header that opens a
 * sheet. The active filter is marked and names its project for assistive technology.
 * The sheet's first row shows every project again.
 */
function ProjectFilter({ projects, project, onChange, alwaysShown = false }: {
  projects: readonly UiProject[];
  project: UiProject | undefined;
  onChange(project: UiProject | undefined): void;
  alwaysShown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const matching = rootLast(projects).filter((candidate) => `${candidate.name} ${candidate.displayPath ?? candidate.path}`.toLocaleLowerCase().includes(search));
  if (!alwaysShown && projects.length < 2 && !project) return null;
  const same = (candidate: UiProject) => candidate.path === project?.path;
  const label = project ? `Filter threads by project: ${project.name}` : "Filter threads by project";
  return <>
    <button type="button" className="touch-icon-button touch-project-filter" data-active={Boolean(project) || undefined} aria-haspopup="dialog" aria-expanded={open} aria-label={label} {...tooltipProps(label, { side: "bottom" })} onClick={() => { setQuery(""); setOpen(true); }}>
      <ListFilter size={20} aria-hidden="true" />
    </button>
    {open ? <Sheet title="Show threads of" className="project-filter-sheet" onClose={() => setOpen(false)}>
      <label className="touch-search-field">
        <Search size={16} aria-hidden="true" />
        <input ref={field} type="search" value={query} placeholder="Name or path" aria-label="Search projects" enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} />
        {query ? <button type="button" className="touch-icon-button" aria-label="Clear search" onClick={() => { setQuery(""); field.current?.focus(); }}><X size={16} /></button> : null}
      </label>
      <div className="project-filter-results">
        <div className="action-sheet-list">
          <button type="button" aria-pressed={!project} onClick={() => { setOpen(false); onChange(undefined); }}>
            <i aria-hidden="true"><Folder size={20} /></i><span>All projects</span>{!project ? <Check size={18} aria-hidden="true" /> : null}
          </button>
          {matching.map((candidate) => <button key={candidate.path} type="button" aria-pressed={same(candidate)} onClick={() => { setOpen(false); onChange(candidate); }}>
            <ProjectIcon project={candidate} />
            <span>{candidate.name}<small>{candidate.displayPath ?? candidate.path}</small></span>
            {same(candidate) ? <Check size={18} aria-hidden="true" /> : null}
          </button>)}
        </div>
        {matching.length === 0 ? <p role="status">No projects found</p> : null}
      </div>
    </Sheet> : null}
  </>;
}

/** A focused search field and threads matching title, project or label, other machines' too. */
function ThreadSearch({ registry, onOpen }: { registry: ExtensionRegistry; onOpen(row: ThreadSupervisionRow, entry?: ThreadListEntry): void }) {
  const store = useThreadStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activity = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const outside = useThreadListSources(registry);
  const marks = useSyncExternalStore(registry.subscribeMarks, registry.getThreadRowMarks);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const results = useMemo(() => query.trim()
    ? threadListGroups(snapshot.threads, activity, { query, extra: outside.rows, marks, shown: { active: SEARCH_RESULTS, settled: SEARCH_RESULTS } }).flatMap((group) => group.rows).slice(0, SEARCH_RESULTS)
    : [], [activity, marks, outside.rows, query, snapshot.threads]);
  return <>
    <label className="touch-search-field">
      <Search size={16} aria-hidden="true" />
      <input ref={field} type="search" value={query} placeholder="Title, project or branch" aria-label="Search threads" enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} />
      {query ? <button type="button" className="touch-icon-button" aria-label="Clear search" onClick={() => { setQuery(""); field.current?.focus(); }}><X size={16} /></button> : null}
    </label>
    {query.trim() ? results.length > 0 ? <ul className="touch-search-results" aria-label="Search results">
      {results.map((row) => {
        const entry = outside.byKey.get(row.id);
        const machine = entry?.machine;
        return <li key={row.id}>
          <button type="button" onClick={() => onOpen(row, entry)}>
            <strong>{row.title}</strong>
            <small>{row.projectLabel ? `${row.projectName} · ${row.projectLabel}` : row.projectName}{machine ? <> · <span className="touch-thread-machine">{machine.icon}<span>{machine.name}</span></span></> : null}</small>
          </button>
        </li>;
      })}
    </ul> : <p className="touch-search-empty" role="status">
      No thread matches “{query.trim()}”.
      <button type="button" onClick={() => { setQuery(""); field.current?.focus(); }}>Clear search</button>
    </p> : <p className="touch-search-empty">Searches every thread, settled ones too.</p>}
  </>;
}
