import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArchiveRestore, ArrowLeft, Check, ChevronDown, CornerLeftUp, Eye, Folder, FolderOpen, GitBranch, Plus, Search, Settings, SlidersHorizontal, SquarePen, Trash2 } from "lucide-react";
import {
  DraftRow,
  errorMessage,
  ProjectIcon,
  Menu,
  MiddleTruncate,
  type MenuSection,
  READ_ONLY_REASON,
  ThreadRow,
  tooltipProps,
  useClientStorage,
  useContextMenu,
  useEscapeLayer,
  useHostCapabilities,
  usePreferences,
  useProjectIcon,
  useThreadStore,
  useWorkbenchShell,
  VirtualList,
  type DraftThread,
  type ProjectSourceProps,
  type SidebarContributionProps,
  threadRowStatus,
  type ThreadActivity,
  type ThreadRowStatus,
  type UiProject,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import { repositoryFolderName, WORKSPACE_HOST_EXTENSION_ID, type RailExternalThread, type ThreadRailSection, type ThreadRailOrganizer, type ThreadRailRowAction, type UiDirectoryListing } from "./protocol.js";
import { useRailDrag } from "./rail-drag.js";
import { mergeByTime, useRailExternalThreads } from "./rail-external.js";
import { ThreadCard, ThreadCardLayer, type ThreadCardTarget } from "./thread-card.js";
import { groupThreads, readRailOrder, sortThreads, type RailOrder } from "./rail-order.js";
import { NO_SELECTION, selectRange, selectedInOrder, toggleSelected, type RailSelection } from "./rail-selection.js";
import { readProjectIcon, writeProjectIcon } from "./project-icons.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";
import { useWorkspaceStore } from "./store-context.js";
import { SidebarFooter } from "./sidebar-footer.js";
import { readShelvesOpen, SHELF_PAGE, shelfFirstPage, shelfHeading, shelfIsOpen, shelfRows as rowsOfShelf, writeShelvesOpen, type ShelvesOpen } from "./rail-shelves.js";

export const WORKSPACE_EXTENSION_ID = WORKSPACE_HOST_EXTENSION_ID;

/** A card (70 px, the design's) and the 2 px between two. */
const ROW_STRIDE = 72;
const THREAD_PAGE_SIZE = 25;

export type NavigationRow =
  | { kind: "group"; id: string; label: string; count: number; project?: UiProject }
  | { kind: "more"; id: string; key: string; remaining: number }
  | { kind: "thread"; id: string; session: UiSession };

function ShowMoreThreadRow({ remaining, all = false, onClick }: { remaining: number; all?: boolean; onClick(): void }) {
  const count = all ? remaining : Math.min(THREAD_PAGE_SIZE, remaining);
  return (
    <article className="thread-row compact thread-pagination-row">
      <button className="thread-main" onClick={onClick}>+ show {count} more</button>
    </article>
  );
}

/**
 * A thread nobody has written to yet is a draft, not a row,
 * unless it is already at work. Threads an agent spawned are never in the rail — not in the settled shelf,
 * not in a search, not even while one is the thread on screen after a take-over
 * (the header above the transcript names it). Fifty of them would bury the
 * threads the user started; the Agents panel and the stage tabs it opens are
 * where they belong.
 *
 * A thread is an agent's when an extension published its lineage, or when the
 * thread index read the link off the thread's own session file - which is what
 * keeps them out of the rail on a machine no extension has told anything yet.
 */
export function visibleThreads(
  sessions: readonly UiSession[],
  parents: Readonly<Record<string, string>>,
  live: (id: string) => boolean = () => false,
): UiSession[] {
  return sessions.filter((session) =>
    !(parents[session.id] ?? session.parentThreadId) && (session.messageCount > 0 || live(session.id)));
}

/** The main list as the rail draws it: flat, or in groups that show `preview` threads until opened. */
export function navigationRowsFor(threads: readonly UiSession[], order: RailOrder, projects: readonly UiProject[], openGroups: ReadonlySet<string>): NavigationRow[] {
  if (order.grouping === "none") return threads.map((session) => ({ kind: "thread" as const, id: session.id, session }));
  const projectOf = (session: UiSession) => findProjectForSession(projects, session);
  return groupThreads(threads, order.grouping, order.projectSort, projectOf).flatMap((group): NavigationRow[] => {
    const shown = openGroups.has(group.key) ? group.threads : group.threads.slice(0, order.preview);
    const project = group.threads[0] ? projectOf(group.threads[0]) : undefined;
    return [
      { kind: "group", id: `group:${group.key}`, label: group.label, count: group.threads.length, ...(project ? { project } : {}) },
      ...shown.map((session) => ({ kind: "thread" as const, id: session.id, session })),
      ...(shown.length < group.threads.length ? [{ kind: "more" as const, id: `more:${group.key}`, key: group.key, remaining: group.threads.length - shown.length }] : []),
    ];
  });
}

export function navigationRowKey(rows: readonly NavigationRow[], index: number): string | number {
  return rows[index]?.id ?? index;
}

function fuzzyMatch(value: string, query: string): boolean {
  let at = 0;
  const haystack = value.toLocaleLowerCase();
  for (const character of query.toLocaleLowerCase()) {
    at = haystack.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** `/Users/me/x` reads as `~/x`; the host expands `~` again when the path is typed back. */
function homeRelative(path: string): string {
  const home = path.match(/^\/(?:Users|home)\/[^/]+/u)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

function withSeparator(path: string): string {
  return /[\\/]$/u.test(path) ? path : `${path}/`;
}

/** The folder part of a typed path and the name being typed after it. */
function splitTypedPath(text: string): { folder: string; leaf: string } {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  return { folder: text.slice(0, cut), leaf: text.slice(cut) };
}

/** Names that start with what was typed, then names that contain it. */
function namesMatching<T extends { name: string }>(entries: readonly T[], typed: string): T[] {
  const needle = typed.toLocaleLowerCase();
  if (!needle) return [...entries];
  const starts = entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(needle));
  return [...starts, ...entries.filter((entry) => !starts.includes(entry) && entry.name.toLocaleLowerCase().includes(needle))];
}

const MOD_LABEL = typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform) ? "⌘" : "Ctrl";

/**
 * Browse the host's folders by typing a path:
 * the part before the last `/` is the folder listed, the rest filters it.
 */
export function LocalFolderSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const store = useWorkspaceStore();
  const host = store.host;
  const [listing, setListing] = useState<UiDirectoryListing>();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(-1);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const { folder, leaf } = splitTypedPath(text);
  const current = missing ? undefined : listing;
  const directories = useMemo(() => namesMatching(current?.directories ?? [], leaf), [current, leaf]);
  const highlighted = selected >= 0 ? directories[selected] : undefined;

  /** Lists `path`; a typed folder keeps the text, a clicked one replaces it. */
  const load = useCallback(async (path?: string, options: { fallBack?: boolean; keepText?: boolean } = {}) => {
    const ticket = ++request.current;
    try {
      const next = await host.listDirectories(path).catch((failure: unknown) => {
        // A base folder that is gone opens the home folder instead of an error.
        if (options.fallBack) return host.listDirectories();
        throw failure;
      });
      if (ticket !== request.current) return;
      setListing(next);
      setMissing(false);
      setSelected(-1);
      if (!options.keepText) setText(withSeparator(homeRelative(next.path)));
      inputRef.current?.focus();
    } catch {
      if (ticket === request.current) setMissing(true);
    }
  }, [host]);
  useEffect(() => {
    const base = store.projectBaseDirectory();
    void load(base, { fallBack: base !== undefined });
  }, [load, store]);

  const listedFolder = listing ? withSeparator(homeRelative(listing.path)) : undefined;
  useEffect(() => {
    if (!folder || folder === listedFolder) { setMissing(false); return; }
    const timer = window.setTimeout(() => void load(folder, { keepText: true }), 120);
    return () => window.clearTimeout(timer);
  }, [folder, listedFolder, load]);

  const add = async (directory?: { path: string }) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const target = directory ? await host.listDirectories(directory.path) : current;
      if (await actions.openWorkspace(target.workspace.workspaceId)) onDone();
    } catch (error) {
      actions.notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    try {
      const picked = await host.pickFolder();
      if (picked && await actions.openWorkspace(picked.workspaceId)) onDone();
    } catch (error) {
      actions.notify(errorMessage(error));
    }
  };
  const addLabel = highlighted ? `${MOD_LABEL} ↵` : "↵";

  return <div className="folder-browser">
    <header className="project-modal-bar">
      <button type="button" className="project-modal-bar-glyph" onClick={onBack} aria-label="Back to project sources"><ArrowLeft size={15} /></button>
      <input
        ref={inputRef}
        value={text}
        spellCheck={false}
        onChange={(event) => { setText(event.target.value); setSelected(-1); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, directories.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(-1, value - 1)); }
          if (event.key === "Tab" && (highlighted ?? directories[0])) { event.preventDefault(); void load((highlighted ?? directories[0]).path); }
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) void add(highlighted);
            else if (highlighted) void load(highlighted.path);
            else void add();
          }
          if (event.key === "Backspace" && !leaf && listing?.parent && folder === listedFolder) { event.preventDefault(); void load(listing.parent); }
        }}
        placeholder="~/path/to/project"
        aria-label="Folder path"
      />
      <button type="button" className="project-modal-bar-action" disabled={!current || busy} onClick={() => void add(highlighted)}>
        Add <kbd>{addLabel}</kbd>
      </button>
    </header>
    <div className="project-picker-heading"><span>Folders</span> <small>{current ? directories.length : ""}</small></div>
    <div className="folder-browser-results" role="listbox" aria-label="Folders">
      {current?.parent && !leaf ? <button type="button" onClick={() => void load(current.parent)}><CornerLeftUp size={15} /><span>..</span></button> : null}
      {current ? directories.map((directory, index) => <button
        type="button"
        role="option"
        aria-selected={selected === index}
        className={selected === index ? "selected" : ""}
        key={directory.path}
        onMouseMove={() => setSelected(index)}
        onClick={() => void load(directory.path)}
      ><Folder size={15} /><span>{directory.name}</span></button>) : null}
      {missing ? <p>No folder at {folder}</p> : current && directories.length === 0 ? <p>{leaf ? `Enter adds ${folder} — no folder here matches “${leaf}”` : "No folders in here"}</p> : null}
    </div>
    <footer className="project-modal-footer">
      <button type="button" onClick={() => void choose()}><FolderOpen size={14} /> Choose a folder…</button>
      <small className="keyboard-hint"><kbd>↑↓</kbd> select <kbd>⇥</kbd> complete</small>
    </footer>
  </div>;
}

export function CloneProjectSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const store = useWorkspaceStore();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const base = store.projectBaseDirectory();
  const url = repositoryUrl.trim();
  const canSubmit = url.length > 0 && !busy;

  /** With a base folder the clone starts at once; without one, or asked to, the host's picker chooses. */
  const submit = async (intoBase: boolean) => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const started = await store.host.startClone(url, intoBase ? base : undefined);
      if (!started) return;
      store.clones.bind(actions);
      store.clones.receive(started);
      onDone();
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="clone-project-form" onSubmit={(event) => { event.preventDefault(); void submit(Boolean(base)); }}>
      <header className="project-modal-bar">
        <button type="button" className="project-modal-bar-glyph" onClick={onBack} aria-label="Back to project sources"><ArrowLeft size={15} /></button>
        <input autoFocus spellCheck={false} value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="Git clone URL (HTTPS or SSH)" aria-label="Git repository URL" disabled={busy} />
        <button type="submit" className="project-modal-bar-action" disabled={!canSubmit}>
          {busy ? "Starting…" : base ? "Clone" : "Continue"} <kbd>↵</kbd>
        </button>
      </header>
      <div className="project-picker-heading"><span>Clone into</span></div>
      <div className="clone-project-destination">
        <GitBranch size={15} aria-hidden="true" />
        {base
          ? <code title={base}>{`${homeRelative(base.replace(/[\\/]+$/u, ""))}/${url ? repositoryFolderName(url) : "…"}`}</code>
          : <span>A folder you choose next</span>}
      </div>
      <footer className="project-modal-footer">
        {base ? <button type="button" disabled={!canSubmit} onClick={() => void submit(false)}><FolderOpen size={14} /> Clone somewhere else…</button> : null}
        <small className="keyboard-hint">{base ? "Runs in the background" : "Settings → Source control sets a default folder"}</small>
      </footer>
    </form>
  );
}

export function findProjectForSession(
  projects: readonly UiProject[],
  session: Pick<UiSession, "projectPath"> & Partial<Pick<UiSession, "projectName" | "workspaceId">>,
): UiProject | undefined {
  if (!projects.length) return undefined;
  const byPath = projects.find((project) => project.path === session.projectPath);
  if (byPath) return byPath;

  if (session.workspaceId) {
    const byWorkspace = projects.find((project) => project.workspaceId === session.workspaceId);
    if (byWorkspace) return byWorkspace;
  }

  const bySubpath = projects.find((project) => {
    const prefix = project.path.endsWith("/") ? project.path : `${project.path}/`;
    return session.projectPath.startsWith(prefix);
  });
  if (bySubpath) return bySubpath;

  if (session.projectName) {
    const byName = projects.filter((project) => project.name === session.projectName);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      const bySharedDir = byName.find((project) => {
        const parentDir = project.path.slice(0, project.path.lastIndexOf("/"));
        return Boolean(parentDir && session.projectPath.startsWith(parentDir));
      });
      return bySharedDir ?? byName[0];
    }
  }

  return undefined;
}

const switcherRequests = new Set<() => void>();

/** Opens the rail's project switcher; the kit's `workspace.switch-project` command, which no chord is bound to by default. */
export function requestProjectSwitcher(): void {
  for (const open of switcherRequests) open();
}

type ProjectEntry = { kind: "all" } | { kind: "project"; project: UiProject };

/** Threads the rail lists, per project name (the filter's key) and in all. */
export function railThreadCounts(sessions: readonly UiSession[], parents: Readonly<Record<string, string>>): { all: number; byName: ReadonlyMap<string, number> } {
  const byName = new Map<string, number>();
  const shown = visibleThreads(sessions, parents);
  for (const session of shown) byName.set(session.projectName, (byName.get(session.projectName) ?? 0) + 1);
  return { all: shown.length, byName };
}

/** Name hits first, then letters of the name in order, then the path; a fuzzy path would match every sibling repo. */
export function rankProjects(projects: readonly UiProject[], query: string): UiProject[] {
  const needle = query.toLocaleLowerCase();
  const tier = (project: UiProject) => {
    const name = project.name.toLocaleLowerCase();
    if (name.includes(needle)) return 0;
    if (fuzzyMatch(name, needle)) return 1;
    return homeRelative(project.displayPath ?? project.path).toLocaleLowerCase().includes(needle) ? 2 : 3;
  };
  return projects.map((project) => ({ project, rank: tier(project) })).filter((entry) => entry.rank < 3)
    .sort((left, right) => left.rank - right.rank).map((entry) => entry.project);
}

/** Keeps the last folder with its slash, up to 16 characters, so the count still fits. */
const pathTail = (path: string) => Math.min(path.length - path.lastIndexOf("/"), 16);

const threadsLabel = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

/**
 * A searchable list of the host's projects under the rail's search (design 1u).
 * As the switcher (`workspace.switch-project`) a pick opens the project; as the
 * rail's project filter "All projects" leads it, the shown one is checked, and
 * each row has its project's settings.
 */
export function ProjectSwitcherPopover({
  activePath,
  open,
  projects,
  onClose,
  onSelect,
  label = "Switch project",
  heading,
  all,
  selectedName,
  counts,
  onSettings,
  footer,
}: {
  activePath?: string;
  open: boolean;
  projects: readonly UiProject[];
  onClose(): void;
  onSelect(project: UiProject): void;
  label?: string;
  heading?: string;
  /** A first row for every project, while nothing is typed. */
  all?: { label: string; onSelect(): void };
  /** The filter's project: checked, and the rows say "current" no more. */
  selectedName?: string | undefined;
  /** Thread counts for each row's second line. */
  counts?: { all: number; byName: ReadonlyMap<string, number> } | undefined;
  onSettings?(project: UiProject): void;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtering = all !== undefined;
  const entries = useMemo((): ProjectEntry[] => {
    const needle = query.trim();
    const matches = needle ? rankProjects(projects, needle) : projects;
    return [...(all && !needle ? [{ kind: "all" as const }] : []), ...matches.map((project) => ({ kind: "project" as const, project }))];
  }, [all, projects, query]);
  const currentProject = useMemo(
    () => findProjectForSession(projects, { projectPath: activePath ?? "" }),
    [projects, activePath],
  );
  const currentPath = currentProject?.path ?? activePath;
  const isPicked = (entry: ProjectEntry) => filtering
    ? entry.kind === "all" ? !selectedName : entry.project.name === selectedName
    : entry.kind === "project" && entry.project.path === currentPath;
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(Math.max(0, filtering
      ? (selectedName ? 1 + projects.findIndex((project) => project.name === selectedName) : 0)
      : projects.findIndex((project) => project.path === currentPath)));
    window.setTimeout(() => inputRef.current?.focus(), 0);
    // Where the list starts is read when it opens, not while it is open.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, open, projects]);
  // Escape closes it wherever the keyboard is, and stops nothing behind it.
  useEscapeLayer(onClose, open);
  if (!open) return null;
  const pick = (entry: ProjectEntry | undefined) => {
    if (entry?.kind === "all") all?.onSelect();
    else if (entry) onSelect(entry.project);
  };

  return <>
    <button type="button" className="project-switcher-scrim" aria-label={`Close ${label.toLocaleLowerCase()}`} onClick={onClose} />
    <section className={`project-switcher-popover${filtering ? " project-filter-popover" : ""}`} role="dialog" aria-label={label}>
      <label className="project-switcher-search"><Search size={13} aria-hidden="true" /><input
        ref={inputRef}
        value={query}
        placeholder="Search projects…"
        aria-label="Search projects"
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, Math.max(0, entries.length - 1))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
          if (event.key === "Enter") { event.preventDefault(); pick(entries[selected]); }
          // The menu key opens the highlighted project's settings.
          const highlighted = entries[selected];
          if (onSettings && highlighted?.kind === "project" && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            onSettings(highlighted.project);
          }
        }}
      /></label>
      {heading ? <div className="project-switcher-heading">{heading}</div> : null}
      <VirtualList
        items={entries}
        itemHeight={45}
        overscan={5}
        className="project-switcher-results"
        role="listbox"
        scrollToIndex={selected}
        empty={<p>No matching projects</p>}
        renderItem={(entry, index) => {
          const picked = isPicked(entry);
          const project = entry.kind === "project" ? entry.project : undefined;
          const name = project ? project.name : all?.label ?? "";
          const count = counts ? threadsLabel(project ? counts.byName.get(project.name) ?? 0 : counts.all) : undefined;
          const fullPath = project ? project.displayPath ?? project.path : undefined;
          const shortPath = fullPath ? homeRelative(fullPath) : undefined;
          return <div
            role="none"
            className={`project-switcher-option${selected === index ? " selected" : ""}${filtering && picked ? " picked" : ""}`}
            key={project?.path ?? "all"}
            onMouseMove={() => setSelected(index)}
          >
            <button
              type="button"
              role="option"
              aria-label={name}
              aria-selected={selected === index}
              aria-checked={filtering ? picked : undefined}
              className="project-switcher-pick"
              onClick={() => pick(entry)}
            >
              {project
                ? <ProjectIcon project={project} />
                : <i className="all-projects" aria-hidden="true"><Folder size={13} /></i>}
              <span>
                <strong>{name}</strong>
                {/* The count never shrinks; a long path gives up its middle and keeps its last folder. */}
                {count || shortPath ? <small>
                  {count ? <span className="project-switcher-count">{count}{shortPath ? " ·\u00a0" : ""}</span> : null}
                  {shortPath ? <MiddleTruncate value={shortPath} tail={pathTail(shortPath)} {...tooltipProps(fullPath, { side: "right" })} /> : null}
                </small> : null}
              </span>
              {filtering ? picked ? <Check size={13} aria-hidden="true" /> : null : picked ? <small className="current">current</small> : null}
            </button>
            {project && onSettings ? <button
              type="button"
              tabIndex={-1}
              className="project-switcher-settings"
              aria-label={`Project settings for ${project.name}`}
              {...tooltipProps(`Project settings for ${project.name}`, { side: "right" })}
              onClick={() => onSettings(project)}
            ><Settings size={13} /></button> : null}
          </div>;
        }}
      />
      {footer ? <footer className="project-switcher-footer">{footer}</footer> : null}
    </section>
  </>;
}

/**
 * The rail's project filter between the search and "+": a folder for every
 * project, the shown project's tile and name while one is (design 1k). Its
 * footer opens a project and the project settings.
 */
function ProjectFilterButton({ actions }: { actions: WorkbenchActions }) {
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const { registry } = useWorkbenchShell();
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const filter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const [open, setOpen] = useState(false);
  const { readOnly } = useHostCapabilities();
  // Counted from the thread index when it opens; no host call.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => open ? railThreadCounts(threadStore.getSnapshot().threads, registry.getThreadLineage().parents) : undefined, [open]);
  const shown = filter ? projects.find((project) => project.name === filter) : undefined;
  const label = filter ? `Filter threads by project: ${filter}` : "Filter threads by project";
  const close = () => setOpen(false);
  const openShortcut = registry.keybindingLabel("workspace.open-project");
  return <>
    <button
      type="button"
      className={`sidebar-action project-filter${filter ? " filtered" : ""}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...tooltipProps(open ? undefined : label, { side: "bottom" })}
      onClick={() => setOpen((value) => !value)}
    >
      {shown ? <ProjectIcon project={shown} className="project-filter-tile" /> : <Folder size={13} />}
      {filter ? <span>{filter}</span> : null}
      <ChevronDown size={10} />
    </button>
    <ProjectSwitcherPopover
      label="Filter by project"
      heading="Show threads from"
      open={open}
      projects={projects}
      all={{ label: "All projects", onSelect: () => { close(); workspace.setRailProjectFilter(undefined); } }}
      selectedName={filter}
      counts={counts}
      onClose={close}
      onSelect={(project) => { close(); workspace.setRailProjectFilter(project.name); }}
      onSettings={(project) => { close(); workspace.openProjectSettings({ projectPath: project.path, projectName: project.name, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}) }); }}
      footer={<>
        {/* Adding a project changes the host's list; a Read-only device may not (ADR 0024). */}
        {readOnly ? null : <button type="button" onClick={() => { close(); actions.openProjectSources(); }}>
          <Plus size={13} aria-hidden="true" /><span>Open a project…</span>{openShortcut ? <kbd>{openShortcut}</kbd> : null}
        </button>}
        <button type="button" onClick={() => { close(); actions.openSettings("workspace.source-control"); }}>
          <SlidersHorizontal size={13} aria-hidden="true" /><span>Manage projects</span>
        </button>
      </>}
    />
  </>;
}

/** The switcher `workspace.switch-project` opens: a pick opens that project. */
function ProjectSwitcher({ actions }: { actions: WorkbenchActions }) {
  const { snapshot } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const [open, setOpen] = useState(false);
  const activeThread = snapshot?.sessionId ? threadStore.getThread(snapshot.sessionId) : undefined;
  const activeProject = findProjectForSession(projects, {
    projectPath: snapshot?.cwd ?? "",
    projectName: activeThread?.projectName,
    workspaceId: snapshot?.workspaceId,
  });
  useEffect(() => {
    const show = () => setOpen(true);
    switcherRequests.add(show);
    return () => { switcherRequests.delete(show); };
  }, []);
  return <ProjectSwitcherPopover
    activePath={activeProject?.path ?? snapshot?.cwd}
    open={open}
    projects={projects}
    onClose={() => setOpen(false)}
    onSelect={(project) => { setOpen(false); void actions.openWorkspace(project.path); }}
  />;
}

/** The rail's tooltip for a thread a provider limit stopped. */

/** A compact age: `now`, `5m`, `3h`, then days however many (`40d`), never a date. */
export function sessionAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function RailRowAction({ action, session, organizer, actions }: {
  action: ThreadRailRowAction;
  session: UiSession;
  organizer: ThreadRailOrganizer;
  actions: WorkbenchActions;
}) {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; sections: MenuSection[] }>();
  return <>
    <button type="button" aria-label={action.label} aria-haspopup="menu" aria-expanded={Boolean(menu)}
      {...tooltipProps(action.label)}
      onClick={(event) => {
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenu(menu ? undefined : { at: { x: bounds.left, y: bounds.bottom }, sections: action.menu() });
      }}>{action.icon}</button>
    {menu ? <Menu at={menu.at} sections={menu.sections} label={action.label}
      onSelect={(choice) => organizer.runMenu(session, choice, actions)}
      onClose={() => setMenu(undefined)} /> : null}
  </>;
}

const ConnectedThreadRow = memo(function ConnectedThreadRow({
  id,
  active,
  activity,
  activityLabel,
  activityHint,
  activityIcon,
  compact,
  workingChildren,
  modelProvider,
  startedAt,
  onSelect,
  organizer,
  actions,
}: {
  organizer?: ThreadRailOrganizer;
  actions: WorkbenchActions;
  id: string;
  active: boolean;
  activity: ThreadActivity;
  activityLabel?: string;
  activityHint?: string;
  activityIcon?: ReactNode;
  compact: boolean;
  workingChildren: number;
  modelProvider?: string;
  startedAt?: number;
  onSelect(path: string): Promise<boolean>;
}) {
  const { readOnly } = useHostCapabilities();
  const preferences = usePreferences();
  const store = useThreadStore();
  const session = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(id, listener), [id, store]),
    useCallback(() => store.getThread(id), [id, store]),
  );
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const workspace = useWorkspaceStore();
  const accessories = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowAccessories);
  const stat = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().turnStats[id]);
  const owner = useMemo(() => session ? findProjectForSession(projects, session) : undefined, [projects, session]);
  const icon = useProjectIcon(owner);
  if (!session) return null;
  const age = sessionAge(session.modifiedAt);
  const diff = stat && !compact && activity !== "settled"
    ? <span key="diff" className="thread-diff-stat" aria-label={`Last turn: ${stat.added} lines added, ${stat.removed} removed`}><b>+{stat.added}</b> <i>−{stat.removed}</i></span>
    : null;
  const marks = accessories.map((Accessory, index) => <Accessory key={index} session={session} />);
  return (
    <ThreadRow
      session={session}
      accessory={diff || marks.length > 0 ? <>{diff}{marks}</> : undefined}
      projectIcon={icon}
      active={active}
      age={age}
      activity={activity}
      activityLabel={activityLabel}
      activityHint={activityHint}
      activityIcon={activityIcon}
      hoverCard
      compact={compact}
      workingChildren={workingChildren}
      modelProvider={modelProvider}
      startedAt={startedAt}
      onSelect={onSelect}
      onToggleSettled={readOnly ? undefined : () => {
        if (organizer) organizer.runMenu(session, activity === "settled" ? "unsettle" : "settle", actions);
        else preferences.toggleSettled(session.id);
      }}
      actions={!readOnly && organizer ? organizer.rowActions?.(session).map((action) =>
        <RailRowAction key={action.id} action={action} session={session} organizer={organizer} actions={actions} />
      ) : undefined}
    />
  );
});

/**
 * The drafts a new thread leaves, which the rail shows at the top of the
 * active threads: the one on screen from the
 * moment it opens, and every one left with something in it. A draft whose
 * thread the host already lists is that thread's row now.
 */
export function railDrafts(drafts: readonly DraftThread[], filter: { project?: string; listed?: ReadonlySet<string> }): DraftThread[] {
  return drafts.filter((draft) =>
    !(draft.sessionId && filter.listed?.has(draft.sessionId)) &&
    (!filter.project || draft.projectName === filter.project));
}

const DraftRailRow = memo(function DraftRailRow({ draft, onOpen }: { draft: DraftThread; onOpen(draftId: string): void }) {
  const store = useThreadStore();
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const icon = useProjectIcon(useMemo(() => findProjectForSession(projects, draft), [draft, projects]));
  return <DraftRow draft={draft} {...(icon ? { projectIcon: icon } : {})} onOpen={onOpen} />;
});

/** Subscribes to the drafts on its own, so typing in a draft repaints these rows and nothing else. */
const RailDrafts = memo(function RailDrafts({ actions, project, listed }: { actions: WorkbenchActions; project?: string; listed: ReadonlySet<string> }) {
  const store = useThreadStore();
  const drafts = useSyncExternalStore(store.subscribeToDrafts, store.getDrafts);
  const shown = useMemo(() => railDrafts(drafts, { ...(project ? { project } : {}), listed }), [drafts, listed, project]);
  const openContextMenu = useContextMenu();
  if (!actions.openDraft || shown.length === 0) return null;
  // Discard is the draft's menu: the row keeps its quiet "draft" on hover, as a thread keeps its state.
  const menu = (event: ReactMouseEvent, draft: DraftThread) => {
    event.stopPropagation();
    void openContextMenu(event, [
      { items: [{ id: "open", label: "Open draft", icon: <SquarePen size={13} /> }] },
      ...(actions.discardDraft ? [{ items: [{ id: "discard", label: "Discard draft", icon: <Trash2 size={13} />, destructive: true }] }] : []),
    ]).then((choice) => {
      if (choice === "open") actions.openDraft?.(draft.draftId);
      if (choice === "discard") actions.discardDraft?.(draft.draftId);
    });
  };
  return (
    <div className="rail-drafts" role="group" aria-label="Drafts">
      {shown.map((draft) => (
        <div key={draft.draftId} className="rail-row rail-draft" onContextMenu={(event) => menu(event, draft)}>
          <DraftRailRow draft={draft} onOpen={actions.openDraft!} />
        </div>
      ))}
    </div>
  );
});

/**
 * Another machine's thread among this machine's: the same card, with that
 * machine's mark before the provider marks. It opens there; it cannot be settled here.
 */
const ExternalThreadRow = memo(function ExternalThreadRow({ thread, onOpen, onLookIn }: {
  thread: RailExternalThread;
  onOpen(thread: RailExternalThread): void;
  onLookIn(thread: RailExternalThread): void;
}) {
  const { session, machine, unavailable, opening, running } = thread;
  const age = sessionAge(session.modifiedAt);
  const activity: ThreadActivity = opening ? "ready" : running ? "working" : "idle";
  const label = opening ? "Opening…" : running ? "Working" : undefined;
  const lookIn = thread.lookIn && !unavailable && !opening
    ? <button type="button" aria-label={`Look in on ${session.title} here`} {...tooltipProps("Read it in a tab here; the window stays on this machine")} onClick={() => onLookIn(thread)}><Eye size={13} /></button>
    : undefined;
  return (
    <div className={`rail-external${unavailable ? " unavailable" : ""}`} aria-disabled={unavailable ? true : undefined}>
      <ThreadRow
        session={session}
        machine={machine}
        active={false}
        age={age}
        activity={activity}
        {...(label ? { activityLabel: label } : {})}
        hoverCard
        actions={lookIn}
        onSelect={() => { if (!unavailable && !opening) onOpen(thread); }}
      />
    </div>
  );
});

/** What the rail knows of a row besides its thread, for its hover card. */
interface RailCardFacts {
  activity: ThreadActivity;
  activityLabel?: string;
  activityHint?: string;
  activityIcon?: ReactNode;
  agents: { total: number; working: number };
}

/** A row's hover card for one of this machine's threads; it follows the thread while open. */
function RailThreadCard({ id, facts, actions, onClose }: { id: string; facts: RailCardFacts; actions: WorkbenchActions; onClose(): void }) {
  const store = useThreadStore();
  const preferences = usePreferences();
  const workspace = useWorkspaceStore();
  const session = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(id, listener), [id, store]),
    useCallback(() => store.getThread(id), [id, store]),
  );
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  const stat = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().turnStats[id]);
  const sections = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadCardSections);
  const icon = useProjectIcon(useMemo(() => session ? findProjectForSession(projects, session) : undefined, [projects, session]));
  if (!session) return null;
  return (
    <ThreadCard
      session={session}
      activity={facts.activity}
      {...(facts.activityLabel ? { activityLabel: facts.activityLabel } : {})}
      {...(facts.activityHint ? { activityHint: facts.activityHint } : {})}
      {...(facts.activityIcon ? { activityIcon: facts.activityIcon } : {})}
      age={sessionAge(session.modifiedAt)}
      {...(icon ? { projectIcon: icon } : {})}
      agents={facts.agents}
      {...(stat && facts.activity !== "settled" ? { stat } : {})}
      showCost={showCosts}
      sections={sections}
      actions={actions}
      onClose={onClose}
    />
  );
}

/** The hover card of another machine's row: what that machine's index says, and why it cannot open now. */
function ExternalThreadCard({ thread, actions, onClose }: { thread: RailExternalThread; actions: WorkbenchActions; onClose(): void }) {
  const preferences = usePreferences();
  const workspace = useWorkspaceStore();
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  const sections = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadCardSections);
  const { session, machine, unavailable, opening, running } = thread;
  return (
    <ThreadCard
      session={session}
      activity={opening ? "ready" : running ? "working" : "idle"}
      {...(opening ? { activityLabel: "Opening…" } : running ? { activityLabel: "Working" } : {})}
      age={sessionAge(session.modifiedAt)}
      machine={machine}
      {...(unavailable ? { unavailable } : {})}
      showCost={showCosts}
      sections={sections}
      actions={actions}
      onClose={onClose}
    />
  );
}

/** How many threads `id` spawned, as the index and the published lineage say, and how many work now. */
export function agentCounts(id: string, threads: readonly UiSession[], parents: Readonly<Record<string, string>>, working: number): { total: number; working: number } {
  const children = new Set(Object.keys(parents).filter((child) => parents[child] === id));
  for (const thread of threads) if (thread.parentThreadId === id) children.add(thread.id);
  return { total: Math.max(children.size, working), working };
}

/** The rail's own split when no organizer says otherwise: pins first, settled threads on their shelf. */
export function defaultRailSections(
  threads: readonly UiSession[],
  pinned: readonly string[],
  settled: readonly string[],
  showSettledShelf: boolean,
): ThreadRailSection[] {
  const pins = new Set(pinned);
  const shelved = new Set(showSettledShelf ? settled : []);
  const sorted = threads.slice().sort((left, right) => Number(pins.has(right.id)) - Number(pins.has(left.id)) || right.modifiedAt - left.modifiedAt);
  return [
    { id: "active", threads: sorted.filter((session) => !shelved.has(session.id)) },
    { id: "settled", label: "Settled", shelf: true, collapsed: false, settled: true, threads: sorted.filter((session) => shelved.has(session.id)) },
  ];
}

const noSubscription = () => () => undefined;
const noVersion = () => 0;
const hasFiles = (transfer: DataTransfer | null) => Boolean(transfer && Array.from(transfer.types).includes("Files"));
const rowIdOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-rail-thread]")?.dataset.railThread : undefined;

type ActivitySets = Record<"running" | "waiting", ReadonlySet<string>>;

/** A row's state as the rail draws it: another kit's may bring its own glyph. */
type RailStatus = ThreadRowStatus & { icon?: ReactNode };

/** A settled row shows its age; the label is only the hover card's. */
const SETTLED_STATUS: RailStatus = { activity: "settled", label: "Settled" };

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const lineage = registry.getThreadLineage();
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const organizer = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRailOrganizer);
  const railSections = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railSections);
  const railThreadSources = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railThreadSources);
  const rowStatuses = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowStatuses);
  const externalThreads = useRailExternalThreads(railThreadSources);
  const organizerVersion = useSyncExternalStore(organizer?.subscribe ?? noSubscription, organizer?.getVersion ?? noVersion);
  const projectFilter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const projectSettings = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().projectSettings);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const navigationSnapshot = useSyncExternalStore(threadStore.subscribeToIds, threadStore.getSnapshot);
  const activityState = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const threads = navigationSnapshot.threads;
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE_SIZE);
  const clientStorage = useClientStorage();
  const [shelfOpen, setShelfOpen] = useState<ShelvesOpen>(() => readShelvesOpen(clientStorage));
  const [shelfLimits, setShelfLimits] = useState<Readonly<Record<string, number>>>({});
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [selection, setSelection] = useState<RailSelection>(NO_SELECTION);
  const [fileDrop, setFileDrop] = useState<string>();
  const openContextMenu = useContextMenu();
  // A Read-only device could never send a new thread's first message.
  const { readOnly: readOnlyDevice } = useHostCapabilities();
  const listRef = useRef<HTMLDivElement>(null);
  const paletteKeys = registry.keybindingLabel("runtime.command-palette");

  const option = (id: string, fallback: boolean) =>
    settings.extensionOptions[`${WORKSPACE_EXTENSION_ID}.${id}`] ?? fallback;
  const showSettledShelf = option("show-settled", true);
  const compactRows = option("compact-rows", false);
  const order = useMemo(() => readRailOrder(preferences), [preferences, settings]);

  // A new scope starts without a selection and with the settled tail at its first page.
  useEffect(() => { setSelection(NO_SELECTION); setShelfLimits({}); }, [projectFilter]);

  useEffect(() => {
    workspace.projectsOf = threadStore.getProjects;
    return () => { if (workspace.projectsOf === threadStore.getProjects) workspace.projectsOf = undefined; };
  }, [threadStore, workspace]);

  // Sets, so the filter's check is one lookup however many threads are running.
  const activity = useMemo<ActivitySets>(() => ({
    running: new Set(activityState.runningThreadIds),
    waiting: new Set(activityState.waitingThreadIds),
  }), [activityState]);
  const liveKey = `${activityState.runningThreadIds.join()}|${activityState.waitingThreadIds.join()}`;

  const matching = useMemo(() => sortThreads(
    visibleThreads(threads, lineage.parents, (id) => activity.running.has(id) || activity.waiting.has(id))
      .filter((session) => !projectFilter || session.projectName === projectFilter),
    order.threadSort,
  // `liveKey` stands for the two sets the filter reads.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  ), [threads, lineage.parents, liveKey, projectFilter, order.threadSort]);
  const sections = useMemo(
    () => organizer
      ? organizer.sections(matching)
      : defaultRailSections(matching, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf),
    // The organizer's version says when the same threads would land elsewhere.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [matching, organizer, organizerVersion, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf],
  );
  // Other machines' threads join the main list by the same filters and order; the rail's sections stay this machine's.
  const outside = useMemo(() => {
    const byKey = new Map<string, RailExternalThread>();
    for (const thread of externalThreads) {
      const { session } = thread;
      if (projectFilter && session.projectName !== projectFilter) continue;
      byKey.set(thread.key, thread);
    }
    return byKey;
  }, [externalThreads, projectFilter]);
  const mainIndex = Math.max(0, sections.findIndex((section) => !section.label));
  const ownMain = sections[mainIndex] ?? { id: "active", threads: [] };
  const main = useMemo(
    () => outside.size === 0 ? ownMain : { ...ownMain, threads: mergeByTime(ownMain.threads, [...outside.values()].map((thread) => thread.session), order.threadSort) },
    [order.threadSort, outside, ownMain],
  );
  const listedIds = useMemo(() => new Set(matching.map((session) => session.id)), [matching]);
  // A draft on screen is the active row; the thread the host holds behind it is not.
  const draftOnScreen = useSyncExternalStore(threadStore.subscribeToDrafts, () => threadStore.getDrafts().some((draft) => draft.active));
  const draftCount = useSyncExternalStore(threadStore.subscribeToDrafts, () => railDrafts(threadStore.getDrafts(), projectFilter ? { project: projectFilter } : {}).length);
  const grouped = order.grouping !== "none";
  const visibleActive = grouped ? main.threads : main.threads.slice(0, threadLimit);
  const { drag, onPointerDown } = useRailDrag(organizer, sections);

  const navigationRows = useMemo(() => navigationRowsFor(visibleActive, order, projects, openGroups), [openGroups, order, projects, visibleActive]);
  const rowVirtualizer = useVirtualizer({
    count: navigationRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => navigationRows[index]?.kind === "thread" ? ROW_STRIDE : navigationRows[index]?.kind === "more" ? 34 : 28,
    getItemKey: (index) => navigationRowKey(navigationRows, index),
    overscan: 6,
  });

  // The same derivation as a tablet's and a phone's list, so every client names a state alike.
  const activityFor = (sessionId: string): RailStatus => {
    const mark = rowStatuses[sessionId];
    return mark ? { activity: "waiting", ...mark } : threadRowStatus(sessionId, activityState, threadStore.getThread(sessionId));
  };

  const toggleSettled = useCallback((session: UiSession) => {
    if (organizer) organizer.toggleSettled(session);
    else preferences.toggleSettled(session.id);
  }, [organizer, preferences]);


  const openExternal = useCallback((thread: RailExternalThread) => thread.open(actions), [actions]);
  const lookInExternal = useCallback((thread: RailExternalThread) => thread.lookIn?.(actions), [actions]);

  const renderCard = ({ key, section }: ThreadCardTarget, close: () => void): ReactNode => {
    const external = outside.get(key);
    if (external) return <ExternalThreadCard thread={external} actions={actions} onClose={close} />;
    if (!threadStore.getThread(key)) return null;
    const settled = sections.find((entry) => entry.id === section)?.settled;
    const status = settled ? SETTLED_STATUS : activityFor(key);
    const facts: RailCardFacts = {
      activity: status.activity,
      ...(status.label ? { activityLabel: status.label } : {}),
      ...(status.hint ? { activityHint: status.hint } : {}),
      ...(status.icon ? { activityIcon: status.icon } : {}),
      agents: agentCounts(key, threads, lineage.parents, lineage.workingChildren[key] ?? 0),
    };
    return <RailThreadCard id={key} facts={facts} actions={actions} onClose={close} />;
  };

  const renderRow = (session: UiSession, { activity: status, label, hint, icon }: RailStatus, compact = false) => (
    <ConnectedThreadRow
      key={session.id}
      id={session.id}
      active={!draftOnScreen && session.id === activityState.activeThreadId}
      activity={status}
      activityLabel={label}
      activityHint={hint}
      activityIcon={icon}
      compact={(compact || compactRows) && status !== "settled"}
      workingChildren={lineage.workingChildren[session.id] ?? 0}
      modelProvider={!draftOnScreen && session.id === activityState.activeThreadId ? snapshot?.model?.provider : undefined}
      startedAt={activityState.runningStartedAt[session.id]}
      onSelect={actions.switchSession}
      organizer={organizer}
      actions={actions}
    />
  );

  const shelfRows = (section: ThreadRailSection) => section.shelf
    ? rowsOfShelf(section, shelfIsOpen(section, shelfOpen), shelfLimits[section.id] ?? shelfFirstPage(section), activityState.activeThreadId)
    : section.threads.slice(0, shelfLimits[section.id] ?? THREAD_PAGE_SIZE);
  const toggleShelf = (id: string, open: boolean) => setShelfOpen((current) => {
    const next = { ...current, [id]: open };
    writeShelvesOpen(clientStorage, next);
    return next;
  });

  /** Every row on screen, top to bottom: what the arrow keys walk and a shift-click spans. */
  const orderIds = [
    ...sections.slice(0, mainIndex).flatMap(shelfRows).map((session) => session.id),
    ...navigationRows.flatMap((row) => row.kind === "thread" ? [row.id] : []),
    ...sections.slice(mainIndex + 1).flatMap(shelfRows).map((session) => session.id),
  ];
  const cursorId = orderIds.length ? orderIds[navigationIndex % orderIds.length] : undefined;
  // Another machine's rows are walked by the arrow keys but never picked.
  const ownIds = outside.size ? orderIds.filter((id) => !outside.has(id)) : orderIds;
  const selected = selectedInOrder(selection, ownIds);

  /** A row's wrapper carries what the drag, the menu and the selection read; its classes show where a drop lands. */
  const rowClass = (sectionId: string, id: string, last: boolean): string => {
    const classes = ["rail-row"];
    if (drag?.threadId === id) classes.push("dragging");
    if (drag?.drop?.sectionId === sectionId) {
      if (drag.drop.beforeThreadId === id) classes.push("drop-before");
      else if (last && !drag.drop.beforeThreadId) classes.push("drop-after");
    }
    if (selection.ids.has(id)) classes.push("selected");
    if (fileDrop === id) classes.push("file-drop");
    return classes.join(" ");
  };
  const rowData = (sectionId: string, id: string) => ({
    "data-rail-thread": id,
    "data-rail-section": sectionId,
    ...(id === cursorId ? { "data-cursor": "" } : {}),
  });
  // No `data-rail-thread`: drags, drops, menus and picks leave these rows alone.
  const externalData = (key: string) => ({ "data-rail-external": key, ...(key === cursorId ? { "data-cursor": "" } : {}) });

  const renderSection = (section: ThreadRailSection): ReactNode => {
    // An empty section shows its heading only while a thread could be dropped on it.
    if (section.threads.length === 0 && !drag) return null;
    const open = shelfIsOpen(section, shelfOpen);
    const rows = shelfRows(section);
    const heading = section.shelf ? shelfHeading(section) : `${section.label} · ${section.threads.length}`;
    const limit = shelfLimits[section.id] ?? (section.shelf ? shelfFirstPage(section) : THREAD_PAGE_SIZE);
    const hidden = Math.max(0, section.threads.length - Math.max(limit, rows.length));
    const target = drag?.drop?.sectionId === section.id ? " drop-target" : "";
    return (
      <section key={section.id} className={`${section.shelf ? "settled-shelf" : "rail-section"} rail-section-${section.id}`}>
        {section.shelf ? (
          <button
            className={`settled-shelf-toggle${target}`}
            data-rail-heading={section.id}
            aria-expanded={open}
            onClick={() => toggleShelf(section.id, !open)}
          >
            <span>{heading}</span>
            <b><ChevronDown size={12} /></b>
          </button>
        ) : <div className={`thread-group-label${target}`} data-rail-heading={section.id}>{heading}<i /></div>}
        {rows.map((session, index) => {
          const status = section.settled ? SETTLED_STATUS : activityFor(session.id);
          return (
            <div key={session.id} className={rowClass(section.id, session.id, index === rows.length - 1)} {...rowData(section.id, session.id)}>
              {renderRow(session, status, Boolean(section.shelf))}
            </div>
          );
        })}
        {open && hidden > 0 ? (
          <ShowMoreThreadRow
            remaining={hidden}
            onClick={() => setShelfLimits((current) => ({ ...current, [section.id]: Math.min(section.threads.length, limit + SHELF_PAGE) }))}
          />
        ) : null}
      </section>
    );
  };

  const findSession = (id: string) => sections.flatMap((section) => section.threads).find((session) => session.id === id);
  const clearSelection = () => setSelection((current) => current.ids.size ? { ids: new Set(), ...(current.anchor ? { anchor: current.anchor } : {}) } : current);

  const openMenu = (event: ReactMouseEvent) => {
    const id = rowIdOf(event.target) ?? (event.target === event.currentTarget ? cursorId : undefined);
    // Without an organizer the menu only settles.
    if (!organizer) {
      const session = id ? findSession(id) : undefined;
      if (!session || readOnlyDevice) return;
      const settled = settings.settledThreadIds.includes(session.id);
      void openContextMenu(event, [{ items: [{ id: "settle", label: settled ? "Un-settle thread" : "Settle thread", icon: settled ? <ArchiveRestore size={13} /> : <Check size={13} /> }] }]).then((choice) => { if (choice) toggleSettled(session); });
      return;
    }
    if (selected.length > 1 && organizer.bulkMenu && (!id || selection.ids.has(id))) {
      const sessions = selected.flatMap((selectedId) => findSession(selectedId) ?? []);
      void openContextMenu(event, organizer.bulkMenu(sessions)).then((choice) => {
        if (!choice) return;
        organizer.runBulkMenu?.(sessions, choice, actions);
        setSelection(NO_SELECTION);
      });
      return;
    }
    const session = id ? findSession(id) : undefined;
    if (!session) return;
    if (!selection.ids.has(session.id)) clearSelection();
    // The OS draws it where it can; the page draws its own elsewhere.
    void openContextMenu(event, organizer.menu(session, registry)).then((choice) => { if (choice) organizer.runMenu(session, choice, actions); });
  };

  /** Files dropped on a row open its thread and wait at its composer. */
  const dropFiles = (id: string, files: File[]) => {
    const session = findSession(id);
    if (!session || files.length === 0) return;
    void actions.switchSession(session.path).then((opened) => {
      if (opened) actions.attachFiles?.(files, { sessionId: session.id });
    });
  };

  return (
    <aside className="session-rail">
      <div className="sidebar-controls">
        <div className="thread-search-row">
          {/* Design 1a: the field is the palette's door, ⌘K from anywhere. */}
          <button type="button" className="thread-search" onClick={() => actions.openCommandPalette()}>
            <Search size={13} />
            <span>Search threads</span>
            {paletteKeys ? <kbd className="keyboard-hint">{paletteKeys}</kbd> : null}
          </button>
          <ProjectFilterButton actions={actions} />
          <button
            className="sidebar-action new-thread"
            {...tooltipProps(readOnlyDevice ? READ_ONLY_REASON : "New thread", { side: "bottom", ...(readOnlyDevice ? {} : { shortcut: registry.keybindingLabel("runtime.new-session") }) })}
            aria-label="New thread"
            disabled={readOnlyDevice}
            // A filtered rail offers its project first; the picker still asks.
            onClick={() => {
              const shown = projectFilter ? projects.find((project) => project.name === projectFilter) : undefined;
              actions.newSession(shown ? { workspace: shown.workspaceId ?? shown.path, pick: true } : undefined);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <ProjectSwitcher actions={actions} />
      </div>

      <nav
        className={`session-list${drag ? " rail-dragging" : ""}`}
        aria-label="Threads"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onClickCapture={(event) => {
          const target = event.target as Element;
          const id = rowIdOf(target);
          if (!id || target.closest(".thread-row-actions")) return;
          // Mod-click picks rows, shift-click picks the run from the last one.
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            setSelection((current) => event.shiftKey ? selectRange(current, id, ownIds, activityState.activeThreadId) : toggleSelected(current, id));
            return;
          }
          setSelection((current) => current.ids.size === 0 && current.anchor === id ? current : { ids: new Set(), anchor: id });
        }}
        onContextMenu={openMenu}
        onDragOver={(event) => {
          if (!actions.attachFiles || !hasFiles(event.dataTransfer)) return;
          const id = rowIdOf(event.target);
          if (!id) { setFileDrop(undefined); return; }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setFileDrop(id);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDrop(undefined); }}
        onDrop={(event) => {
          const id = rowIdOf(event.target);
          setFileDrop(undefined);
          if (!id || !actions.attachFiles || !hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dropFiles(id, Array.from(event.dataTransfer.files));
        }}
        onKeyDown={(event) => {
          // A row's own buttons and their popovers keep their keys.
          const target = event.target as Element;
          if (!event.currentTarget.contains(target) || target.closest(".thread-row-actions")) return;
          if (event.key === "Escape" && selection.ids.size) { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
          if (!orderIds.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          const current = navigationIndex % orderIds.length;
          if (event.key === "Enter") {
            const external = outside.get(orderIds[current]!);
            if (external) { if (!external.unavailable) external.open(actions); }
            else void actions.switchSession(findSession(orderIds[current]!)?.path ?? "");
            return;
          }
          const next = (current + (event.key === "ArrowDown" ? 1 : -1) + orderIds.length) % orderIds.length;
          setNavigationIndex(next);
          // Shift and an arrow grow the selection from where it began; a plain arrow moves where it begins.
          if (outside.has(orderIds[next]!)) return;
          if (event.shiftKey) setSelection((selectionNow) => selectRange(selectionNow.anchor ? selectionNow : { ...selectionNow, anchor: orderIds[current]! }, orderIds[next]!, ownIds));
          else setSelection((selectionNow) => selectionNow.ids.size ? selectionNow : { ids: selectionNow.ids, anchor: orderIds[next]! });
        }}
      >
        {/* One scroll; the shelves follow the active threads right after the last one, as in the design. */}
        <div ref={listRef} className="rail-active">
        <div className="rail-active-rows">
        {sections.slice(0, mainIndex).map(renderSection)}
        <RailDrafts actions={actions} {...(projectFilter ? { project: projectFilter } : {})} listed={listedIds} />
        {main.label === undefined && drag && sections.length > 1 ? (
          <div className={`thread-group-label rail-main-label${drag.drop?.sectionId === main.id ? " drop-target" : ""}`} data-rail-heading={main.id}>Active<i /></div>
        ) : null}
        <div className="rail-virtual" style={{ height: rowVirtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}>
          {rowVirtualizer.getVirtualItems().map((item) => {
            const row = navigationRows[item.index];
            if (!row) return null;
            const threadRow = row.kind === "thread";
            return (
              <div
                key={row.id}
                ref={rowVirtualizer.measureElement}
                data-index={item.index}
                className={threadRow ? rowClass(main.id, row.id, item.index === navigationRows.length - 1) : undefined}
                {...(threadRow ? (outside.has(row.id) ? externalData(row.id) : rowData(main.id, row.id)) : {})}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="thread-group-label">{row.label} · {row.count}<i />
                    {/* The project header's "+": a new thread in this project, whatever is on screen. */}
                    {row.project && !readOnlyDevice ? <button
                      type="button"
                      className="thread-group-new"
                      aria-label={`New thread in ${row.project.name}`}
                      {...tooltipProps(`New thread in ${row.project.name}`, { side: "top" })}
                      onClick={() => actions.newSession({ workspace: row.project!.workspaceId ?? row.project!.path })}
                    ><SquarePen size={13} /></button> : null}
                  </div>
                ) : row.kind === "more" ? (
                  <ShowMoreThreadRow remaining={row.remaining} all onClick={() => setOpenGroups((current) => new Set([...current, row.key]))} />
                ) : (() => {
                  const external = outside.get(row.id);
                  if (external) return <ExternalThreadRow thread={external} onOpen={openExternal} onLookIn={lookInExternal} />;
                  const status = activityFor(row.session.id);
                  return renderRow(row.session, status);
                })()}
              </div>
            );
          })}
        </div>

        {visibleActive.length < main.threads.length ? (
          <ShowMoreThreadRow
            remaining={main.threads.length - visibleActive.length}
            onClick={() => setThreadLimit((limit) => Math.min(main.threads.length, limit + THREAD_PAGE_SIZE))}
          />
        ) : null}

        {matching.length === 0 && outside.size === 0 && draftCount === 0 ? (
          <p className="sidebar-empty">{projectFilter ? `No threads in ${projectFilter}` : "No recent threads"}</p>
        ) : null}

        {(() => {
          const shelves = sections.slice(mainIndex + 1).map(renderSection).filter(Boolean);
          return shelves.length ? <div className="rail-shelves">{shelves}</div> : null;
        })()}
        </div>
        </div>
      </nav>

      {drag ? null : <ThreadCardLayer root={listRef} render={renderCard} />}
      {drag?.label ? <div className="rail-drag-label" style={{ left: drag.x + 14, top: drag.y + 10 }}>{drag.label}</div> : null}
      {organizer?.Layer ? <organizer.Layer actions={actions} /> : null}
      {projectSettings ? (
        <ProjectSettingsDialog
          key={projectSettings.path}
          project={projectSettings}
          current={readProjectIcon(preferences, projectSettings)}
          {...(projectSettings.icon ? { automatic: projectSettings.icon } : {})}
          onSave={(choice) => { writeProjectIcon(preferences, projectSettings, choice); workspace.closeProjectSettings(); }}
          onClose={() => workspace.closeProjectSettings()}
          onError={(message) => actions.notify(message)}
        />
      ) : null}

      {railSections.map((Section, index) => <Section key={index} actions={actions} />)}
      {selected.length > 0 ? (
        <div className="rail-selection-bar" role="status">
          <span>{selected.length} selected{selected.length > 1 && organizer?.bulkMenu ? " · right-click for actions" : ""}</span>
          <button type="button" onClick={clearSelection}>Clear</button>
        </div>
      ) : null}
      <SidebarFooter actions={actions} readOnly={readOnlyDevice} />
    </aside>
  );
});
