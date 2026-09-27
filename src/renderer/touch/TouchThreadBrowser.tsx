import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronLeft, Ellipsis, Folder, MonitorSmartphone, Plus, Search, Settings, X } from "lucide-react";
import type { UiProject } from "../../shared/contracts";
import { rootLast } from "../../workbench/new-thread-project";
import { threadListGroups, type ThreadSupervisionRow } from "../../workbench/thread-supervision";
import { useClientEnvironment } from "../client-environment";
import { Popover } from "../components/ui/Dialog";
import { useFocusReturn, useFocusTrap } from "../components/ui/focus";
import { tooltipProps } from "../components/ui/Tooltip";
import { useHostCapabilities } from "../use-host-capabilities";
import { useThreadStore } from "../workbench-context";
import { ActionSheet } from "./ActionSheet";
import { TouchThreadList, type TouchThreadListProps } from "./TouchThreadList";
import "./touch.css";

export { TouchThreadList };

const SEARCH_RESULTS = 20;

/**
 * The thread list with its own header, after the user's mobile rules: search
 * and an overflow menu at the top right as popovers at their buttons, a
 * project filter at the head of the list, and a new thread as the floating
 * button at the bottom right. `home` is a phone's start page while no thread
 * is open; `screen` is the same list over an open thread, and modal;
 * `sidebar` is the list beside the thread on a tablet, where the new thread
 * stays in the header as on a desktop.
 */
export function TouchThreadBrowser({ variant, onClose, onNewThread, onOpenSettings, projects = [], onProjectChange, ...list }: TouchThreadListProps & {
  variant: "home" | "screen" | "sidebar";
  onClose?(): void;
  onNewThread(): void;
  onOpenSettings(page?: string): void;
  projects?: readonly UiProject[];
  onProjectChange?(project: UiProject | undefined): void;
}) {
  const surface = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<"search" | "menu">();
  const modal = variant === "screen";
  const screen = variant !== "sidebar";
  const shell = useClientEnvironment().shell;
  // A Read-only device could never send a new thread's first message.
  const { readOnly } = useHostCapabilities();
  useFocusReturn(modal, surface);
  useFocusTrap(surface, modal && !popover);
  // Modal, so core's own Escape binding stands down for it; closing it is this listener's job.
  useEffect(() => {
    if (!modal || !onClose) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelectorAll('[aria-modal="true"], .popover').length > 1) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [modal, onClose]);

  const header = <header className="touch-browser-header">
    {modal && onClose ? <button type="button" className="touch-icon-button" aria-label="Close threads" onClick={onClose}><ChevronLeft size={22} /></button> : null}
    <strong>Threads</strong>
    <span className="spacer" />
    <button ref={searchButton} type="button" className="touch-icon-button" aria-label="Search threads" aria-expanded={popover === "search"} {...tooltipProps("Search threads", { side: "bottom" })} onClick={() => setPopover(popover === "search" ? undefined : "search")}><Search size={19} /></button>
    <button ref={menuButton} type="button" className="touch-icon-button" aria-label="More" aria-haspopup="menu" aria-expanded={popover === "menu"} {...tooltipProps("More", { side: "bottom" })} onClick={() => setPopover(popover === "menu" ? undefined : "menu")}><Ellipsis size={20} /></button>
    {screen || readOnly ? null : <button type="button" className="touch-icon-button" aria-label="New thread" {...tooltipProps("New thread", { side: "bottom" })} onClick={onNewThread}><Plus size={20} /></button>}
  </header>;

  const popovers = <>
    {popover === "search" ? <Popover anchor={searchButton} side="bottom" align="end" label="Search threads" className="touch-popover touch-search" onClose={() => setPopover(undefined)}>
      <ThreadSearch onOpen={(row) => { setPopover(undefined); list.onOpen(row); }} />
    </Popover> : null}
    {popover === "menu" ? <Popover anchor={menuButton} side="bottom" align="end" label="More" className="touch-popover touch-menu" onClose={() => setPopover(undefined)}>
      <div role="menu" aria-label="More">
        {/* Which host a native shell is on: said here, not over the list. */}
        {shell?.hostLabel ? <p className="touch-menu-context">On {shell.hostLabel}</p> : null}
        <button type="button" role="menuitem" onClick={() => { setPopover(undefined); onOpenSettings(); }}><Settings size={17} />Settings</button>
        <button type="button" role="menuitem" onClick={() => { setPopover(undefined); onOpenSettings("connections"); }}><MonitorSmartphone size={17} />Connections</button>
        {shell?.actions?.map((action) => <button key={action.id} type="button" role="menuitem" onClick={() => { setPopover(undefined); action.run(); }}>{action.Icon ? <action.Icon size={17} /> : null}{action.label}</button>)}
      </div>
    </Popover> : null}
  </>;

  const filter = onProjectChange ? <ProjectFilter projects={projects} project={list.project} onChange={onProjectChange} /> : null;
  if (screen) {
    const body = <>
      {header}
      {filter}
      {/* The floating button is the empty list's next step too. */}
      <TouchThreadList {...list} />
      {readOnly ? null : <button type="button" className="touch-fab" aria-label="New thread" onClick={onNewThread}><Plus size={28} /></button>}
      {popovers}
    </>;
    return modal
      ? <section ref={surface} className="touch-browser screen" role="dialog" aria-modal="true" aria-label="Threads" tabIndex={-1}>{body}</section>
      : <section ref={surface} className="touch-browser screen home" aria-label="Threads">{body}</section>;
  }
  return <nav ref={surface} className="touch-browser sidebar" aria-label="Thread list">
    {header}
    {filter}
    <TouchThreadList {...list} onNewThread={onNewThread} />
    {popovers}
  </nav>;
}

/**
 * Which project's threads the list shows: a button at the list's head that
 * opens a sheet, and a clear button while one is chosen. One project needs no filter.
 */
function ProjectFilter({ projects, project, onChange }: {
  projects: readonly UiProject[];
  project: UiProject | undefined;
  onChange(project: UiProject | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  if (projects.length < 2 && !project) return null;
  const same = (candidate: UiProject) => candidate.path === project?.path;
  return <div className="touch-project-filter">
    <button type="button" className="touch-project-filter-button" aria-haspopup="dialog" aria-label={project ? `Project: ${project.name}. Change` : "Project: all projects. Change"} onClick={() => setOpen(true)}>
      <Folder size={15} aria-hidden="true" />
      <span>{project ? project.name : "All projects"}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    {project ? <button type="button" className="touch-icon-button" aria-label="Show all projects" onClick={() => onChange(undefined)}><X size={17} /></button> : null}
    {open ? <ActionSheet
      title="Show threads of"
      actions={[
        { id: "all", label: "All projects", Icon: project ? undefined : Check, pressed: !project, run: () => onChange(undefined) },
        ...rootLast(projects).map((candidate) => ({ id: candidate.path, label: candidate.name, detail: candidate.displayPath ?? candidate.path, Icon: same(candidate) ? Check : undefined, pressed: same(candidate), run: () => onChange(candidate) })),
      ]}
      onClose={() => setOpen(false)}
    /> : null}
  </div>;
}

/** The search popover: a field with the focus, and the threads it finds by title, project or label. */
function ThreadSearch({ onOpen }: { onOpen(row: ThreadSupervisionRow): void }) {
  const store = useThreadStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activity = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const results = useMemo(() => query.trim()
    ? threadListGroups(snapshot.threads, activity, { query, shown: { active: SEARCH_RESULTS, settled: SEARCH_RESULTS } }).flatMap((group) => group.rows).slice(0, SEARCH_RESULTS)
    : [], [activity, query, snapshot.threads]);
  return <>
    <label className="touch-search-field">
      <Search size={16} aria-hidden="true" />
      <input ref={field} type="search" value={query} placeholder="Title, project or branch" aria-label="Search threads" enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} />
      {query ? <button type="button" className="touch-icon-button" aria-label="Clear search" onClick={() => { setQuery(""); field.current?.focus(); }}><X size={16} /></button> : null}
    </label>
    {query.trim() ? results.length > 0 ? <ul className="touch-search-results" aria-label="Search results">
      {results.map((row) => <li key={row.id}>
        <button type="button" onClick={() => onOpen(row)}>
          <strong>{row.title}</strong>
          <small>{row.projectLabel ? `${row.projectName} · ${row.projectLabel}` : row.projectName}</small>
        </button>
      </li>)}
    </ul> : <p className="touch-search-empty" role="status">
      No thread matches “{query.trim()}”.
      <button type="button" onClick={() => { setQuery(""); field.current?.focus(); }}>Clear search</button>
    </p> : <p className="touch-search-empty">Searches every thread on this host, settled ones too.</p>}
  </>;
}
