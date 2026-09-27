import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ChevronDown, ChevronRight, CornerLeftUp, Folder, FolderOpen, FolderPlus, GitBranch, Search, Settings, SquarePen, X } from "lucide-react";
import {
  errorMessage,
  Popover,
  READ_ONLY_REASON,
  ThreadRow,
  tooltipProps,
  useContextMenu,
  useEscapeLayer,
  useHostCapabilities,
  usePreferences,
  useThreadStore,
  useWorkbenchShell,
  VirtualList,
  type ProjectSourceProps,
  type SidebarContributionProps,
  type ThreadActivity,
  type UiProject,
  type UiSession,
} from "tau";
import { repositoryFolderName, WORKSPACE_HOST_EXTENSION_ID, type ThreadRailRowAction, type ThreadRailSection, type UiDirectoryListing } from "./protocol.js";
import { useRailDrag } from "./rail-drag.js";
import { threadDetails } from "./rail-details.js";
import { groupThreads, readRailOrder, sortThreads, type RailOrder } from "./rail-order.js";
import { NO_SELECTION, selectRange, selectedInOrder, toggleSelected, type RailSelection } from "./rail-selection.js";
import { projectIconKey, readProjectIcon, writeProjectIcon } from "./project-icons.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";
import { useWorkspaceStore } from "./store-context.js";

export const WORKSPACE_EXTENSION_ID = WORKSPACE_HOST_EXTENSION_ID;

const ROW_STRIDE = 78;
const THREAD_PAGE_SIZE = 25;

export type NavigationRow =
  | { kind: "group"; id: string; label: string; count: number }
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
 * A thread nobody has written to yet is a draft, not a row (as in T3 Code),
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

/**
 * The branch every checkout starts on says nothing on a row; T3 Code's card
 * leaves it out too. Until the host names the project's own, `main` and
 * `master` stand in for it.
 */
export function isDefaultBranch(label: string | undefined, defaultBranch?: string): boolean {
  if (defaultBranch !== undefined) return label === defaultBranch;
  return label === "main" || label === "master";
}

/** The main list as the rail draws it: flat, or in groups that show `preview` threads until opened. */
export function navigationRowsFor(threads: readonly UiSession[], order: RailOrder, projects: readonly UiProject[], openGroups: ReadonlySet<string>): NavigationRow[] {
  if (order.grouping === "none") return threads.map((session) => ({ kind: "thread" as const, id: session.id, session }));
  const projectOf = (session: UiSession) => findProjectForSession(projects, session);
  return groupThreads(threads, order.grouping, order.projectSort, projectOf).flatMap((group): NavigationRow[] => {
    const shown = openGroups.has(group.key) ? group.threads : group.threads.slice(0, order.preview);
    return [
      { kind: "group", id: `group:${group.key}`, label: group.label, count: group.threads.length },
      ...shown.map((session) => ({ kind: "thread" as const, id: session.id, session })),
      ...(shown.length < group.threads.length ? [{ kind: "more" as const, id: `more:${group.key}`, key: group.key, remaining: group.threads.length - shown.length }] : []),
    ];
  });
}

export function navigationRowKey(rows: readonly NavigationRow[], index: number): string | number {
  return rows[index]?.id ?? index;
}

function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "·";
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
 * Browse the host's folders by typing a path, as T3 Code's add-project browse:
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

export function ProjectSwitcherPopover({
  activePath,
  open,
  projects,
  onClose,
  onSelect,
  iconOf,
}: {
  activePath?: string;
  open: boolean;
  projects: readonly UiProject[];
  /** A project's chosen icon, when it has one. */
  iconOf?(project: UiProject): string | undefined;
  onClose(): void;
  onSelect(project: UiProject): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => projects.filter((project) => fuzzyMatch(`${project.name} ${project.path}`, query.trim())), [projects, query]);
  const currentProject = useMemo(
    () => findProjectForSession(projects, { projectPath: activePath ?? "" }),
    [projects, activePath],
  );
  const currentPath = currentProject?.path ?? activePath;
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(Math.max(0, projects.findIndex((project) => project.path === currentPath)));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [currentPath, open, projects]);
  // Escape closes it wherever the keyboard is, and stops nothing behind it.
  useEscapeLayer(onClose, open);
  if (!open) return null;
  const activate = () => { const project = matches[selected]; if (project) onSelect(project); };

  return <>
    <button type="button" className="project-switcher-scrim" aria-label="Close project switcher" onClick={onClose} />
    <section className="project-switcher-popover" role="dialog" aria-label="Switch project">
      <label><Search size={15} /><input
        ref={inputRef}
        value={query}
        placeholder="Search projects…"
        aria-label="Search projects"
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, Math.max(0, matches.length - 1))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
          if (event.key === "Enter") { event.preventDefault(); activate(); }
        }}
      /></label>
      <VirtualList
        items={matches}
        itemHeight={42}
        overscan={5}
        className="project-switcher-results"
        role="listbox"
        scrollToIndex={selected}
        empty={<p>No matching projects</p>}
        renderItem={(project, index) => <button
          type="button"
          role="option"
          aria-selected={selected === index}
          className={selected === index ? "selected" : ""}
          key={project.path}
          onMouseMove={() => setSelected(index)}
          onClick={() => onSelect(project)}
        >
          {(() => {
            const icon = iconOf?.(project) ?? project.icon;
            return <i className={icon ? "has-image" : ""}>{icon ? <img src={icon} alt="" aria-hidden="true" /> : projectInitial(project.name)}</i>;
          })()}
          <span>{project.name}</span>
          {project.path === currentPath ? <small>current</small> : null}
          <Settings size={14} aria-hidden="true" />
        </button>}
      />
    </section>
  </>;
}

function ProjectScope({ actions }: SidebarContributionProps) {
  const { snapshot } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const filter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const preferences = usePreferences();
  useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [searchOpen, setSearchOpen] = useState(false);
  const { readOnly } = useHostCapabilities();

  const activeThread = snapshot?.sessionId ? threadStore.getThread(snapshot.sessionId) : undefined;
  const activeProject = findProjectForSession(projects, {
    projectPath: snapshot?.cwd ?? "",
    projectName: activeThread?.projectName,
    workspaceId: snapshot?.workspaceId,
  });

  useEffect(() => {
    const open = () => setSearchOpen(true);
    switcherRequests.add(open);
    return () => { switcherRequests.delete(open); };
  }, []);

  return (
    <>
      <div className="project-scope-row">
        <button className="project-scope" onClick={() => setSearchOpen(true)}>
          <i className="all-projects-icon"><Folder size={15} /></i>
          <span>{filter ?? "All projects"}</span>
          <b><ChevronDown size={14} /></b>
        </button>
        {filter ? (
          <button className="sidebar-action" {...tooltipProps("Show all projects", { side: "bottom" })} aria-label="Show all projects" onClick={() => workspace.setRailProjectFilter(undefined)}>
            <X size={15} />
          </button>
        ) : null}
        {/* Adding a project changes the host's list; a Read-only device may not (ADR 0024). */}
        {readOnly ? null : <button
          className="sidebar-action"
          {...tooltipProps("Add project", { side: "bottom" })}
          aria-label="Add project"
          onClick={() => { setSearchOpen(false); actions.openProjectSources(); }}
        >
          <FolderPlus size={16} />
        </button>}
      </div>
      <ProjectSwitcherPopover
        activePath={activeProject?.path ?? snapshot?.cwd}
        open={searchOpen}
        projects={projects}
        onClose={() => setSearchOpen(false)}
        onSelect={(project) => { setSearchOpen(false); void actions.openWorkspace(project.path); }}
        iconOf={(project) => readProjectIcon(preferences, project)?.image}
      />
    </>
  );
}

/** The rail's tooltip for a thread a provider limit stopped. */
export function limitHint(limit: UiSession["limit"], now = Date.now()): string {
  if (!limit) return "A provider limit stopped this thread.";
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (limit.resumeAt !== undefined) return `A usage limit stopped this thread; it continues by itself at ${time(limit.resumeAt)}.`;
  if (limit.resetsAt !== undefined && limit.resetsAt > now) return `A usage limit stopped this thread; it resets at ${time(limit.resetsAt)}.`;
  return "A usage limit stopped this thread. Open it to continue.";
}

function sessionAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${days}d`
    : new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

const noValue = () => undefined;

/** A project's chosen icon; the raw value is what the row subscribes to, so another project's change leaves it alone. */
function useProjectIcon(project: UiProject | undefined): string | undefined {
  const preferences = usePreferences();
  const raw = useSyncExternalStore(preferences.subscribe, project ? () => preferences.value(WORKSPACE_EXTENSION_ID, projectIconKey(project)) : noValue);
  return useMemo(() => project && raw ? readProjectIcon(preferences, project)?.image : undefined, [preferences, project, raw]) ?? project?.icon;
}

const ConnectedThreadRow = memo(function ConnectedThreadRow({
  id,
  active,
  activity,
  activityLabel,
  activityHint,
  compact,
  workingChildren,
  modelProvider,
  startedAt,
  rowActions,
  onRowAction,
  onSelect,
  onToggleSettled,
}: {
  id: string;
  active: boolean;
  activity: ThreadActivity;
  activityLabel?: string;
  activityHint?: string;
  compact: boolean;
  workingChildren: number;
  modelProvider?: string;
  startedAt?: number;
  rowActions?: (session: UiSession) => ThreadRailRowAction[];
  onRowAction(session: UiSession, itemId: string): void;
  onSelect(path: string): Promise<boolean>;
  onToggleSettled(session: UiSession): void;
}) {
  const store = useThreadStore();
  const preferences = usePreferences();
  const session = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(id, listener), [id, store]),
    useCallback(() => store.getThread(id), [id, store]),
  );
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  const workspace = useWorkspaceStore();
  const accessories = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowAccessories);
  const stat = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().turnStats[id]);
  const project = session ? session.workspaceId ?? session.projectPath : undefined;
  const defaultBranch = useSyncExternalStore(workspace.subscribe, () => project ? workspace.getSnapshot().defaultBranches[project] : undefined);
  const owner = useMemo(() => session ? findProjectForSession(projects, session) : undefined, [projects, session]);
  const icon = useProjectIcon(owner);
  useEffect(() => { if (project) workspace.loadDefaultBranch(project); }, [project, workspace]);
  if (!session) return null;
  const offered = activity === "settled" ? [] : rowActions?.(session) ?? [];
  const age = sessionAge(session.modifiedAt);
  const showStatus = activity !== "idle" && activity !== "settled";
  const diff = stat && !compact && activity !== "settled"
    ? <span key="diff" className="thread-diff-stat" aria-label={`Last turn: ${stat.added} lines added, ${stat.removed} removed`}><b>+{stat.added}</b> <i>−{stat.removed}</i></span>
    : null;
  const marks = accessories.map((Accessory, index) => <Accessory key={index} session={session} />);
  return (
    <ThreadRow
      session={session}
      showLabel={!isDefaultBranch(session.projectLabel, defaultBranch)}
      actions={offered.length > 0
        ? offered.map((action) => <RailRowAction key={action.id} action={action} onPick={(itemId) => onRowAction(session, itemId)} />)
        : undefined}
      accessory={diff || marks.length > 0 ? <>{diff}{marks}</> : undefined}
      showCost={showCosts}
      projectIcon={icon}
      active={active}
      age={age}
      activity={activity}
      activityLabel={activityLabel}
      activityHint={activityHint}
      details={threadDetails({ session, age, ...(showStatus && activityLabel ? { status: activityLabel } : {}), ...(activityHint ? { hint: activityHint } : {}), ...(stat ? { stat } : {}) })}
      compact={compact}
      workingChildren={workingChildren}
      modelProvider={modelProvider}
      startedAt={startedAt}
      onSelect={onSelect}
      onToggleSettled={() => onToggleSettled(session)}
    />
  );
});

/**
 * A row's hover button and the list it drops (T3 Code's snooze clock). The
 * keyboard walks the list like a menu; Escape and a press outside close it and
 * give focus back to the button.
 */
export function RailRowAction({ action, onPick }: { action: ThreadRailRowAction; onPick(itemId: string): void }) {
  const [open, setOpen] = useState<"keyboard" | "pointer">();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  useLayoutEffect(() => {
    // Opened by a click the list takes focus, so no row looks chosen before the pointer is on one.
    if (open) (open === "keyboard" ? items()[0] : list.current)?.focus({ preventScroll: true });
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    // The rail's own arrow keys would take these otherwise.
    event.stopPropagation();
    if (event.key === "Tab") { setOpen(undefined); return; }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? (at < 0 ? all.length : at) - 1
      : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : undefined;
    if (next === undefined || all.length === 0) return;
    event.preventDefault();
    all[(next + all.length) % all.length]?.focus({ preventScroll: true });
  };
  const pick = (itemId: string) => { setOpen(undefined); onPick(itemId); };
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={action.label}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        {...tooltipProps(open ? undefined : action.label)}
        onClick={(event) => setOpen((current) => current ? undefined : event.detail === 0 ? "keyboard" : "pointer")}
      >
        {action.icon}
      </button>
      {open ? (
        <Popover anchor={button} side="bottom" align="start" label={action.label} className="menu rail-row-popover" onClose={() => setOpen(undefined)}>
          <div ref={list} role="menu" aria-label={action.label} tabIndex={-1} onKeyDown={onKeyDown}>
            {action.menu().map((section, index) => (
              <Fragment key={index}>
                {index > 0 ? <hr /> : null}
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={item.disabled}
                    onPointerEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
                    onClick={() => pick(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.hint ? <small className="menu-hint">{item.hint}</small> : null}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
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
    { id: "settled", label: "Settled", shelf: true, settled: true, threads: sorted.filter((session) => shelved.has(session.id)) },
  ];
}

const noSubscription = () => () => undefined;
const noVersion = () => 0;
const hasFiles = (transfer: DataTransfer | null) => Boolean(transfer && Array.from(transfer.types).includes("Files"));
const rowIdOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-rail-thread]")?.dataset.railThread : undefined;

type ActivitySets = Record<"running" | "waiting" | "limited" | "failed" | "interrupted" | "unread", ReadonlySet<string>>;

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const lineage = registry.getThreadLineage();
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const organizer = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRailOrganizer);
  const railSections = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railSections);
  const organizerVersion = useSyncExternalStore(organizer?.subscribe ?? noSubscription, organizer?.getVersion ?? noVersion);
  const projectFilter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const projectSettings = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().projectSettings);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const [threadQuery, setThreadQuery] = useState("");
  const navigationSnapshot = useSyncExternalStore(
    threadQuery ? threadStore.subscribe : threadStore.subscribeToIds,
    threadStore.getSnapshot,
  );
  const activityState = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const threads = navigationSnapshot.threads;
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE_SIZE);
  const [shelfOpen, setShelfOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [shelfLimits, setShelfLimits] = useState<Readonly<Record<string, number>>>({});
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [selection, setSelection] = useState<RailSelection>(NO_SELECTION);
  const [fileDrop, setFileDrop] = useState<string>();
  const openContextMenu = useContextMenu();
  // A Read-only device could never send a new thread's first message.
  const { readOnly: readOnlyDevice } = useHostCapabilities();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const option = (id: string, fallback: boolean) =>
    settings.extensionOptions[`${WORKSPACE_EXTENSION_ID}.${id}`] ?? fallback;
  const showSettledShelf = option("show-settled", true);
  const compactRows = option("compact-rows", false);
  const order = useMemo(() => readRailOrder(preferences), [preferences, settings]);

  // As in T3 Code, a new scope starts without a selection.
  useEffect(() => { setSelection(NO_SELECTION); }, [projectFilter]);

  useEffect(() => {
    workspace.projectsOf = threadStore.getProjects;
    return () => { if (workspace.projectsOf === threadStore.getProjects) workspace.projectsOf = undefined; };
  }, [threadStore, workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sets, so a row's state is one lookup however many threads are running.
  const activity = useMemo<ActivitySets>(() => ({
    running: new Set(activityState.runningThreadIds),
    waiting: new Set(activityState.waitingThreadIds),
    limited: new Set(activityState.limitedThreadIds),
    failed: new Set(activityState.failedThreadIds),
    interrupted: new Set(activityState.interruptedThreadIds),
    unread: new Set(activityState.unreadThreadIds),
  }), [activityState]);
  const liveKey = `${activityState.runningThreadIds.join()}|${activityState.waitingThreadIds.join()}`;

  const needle = threadQuery.trim().toLocaleLowerCase();
  const matching = useMemo(() => sortThreads(
    visibleThreads(threads, lineage.parents, (id) => activity.running.has(id) || activity.waiting.has(id))
      .filter((session) =>
        (!projectFilter || session.projectName === projectFilter) &&
        (!needle || `${session.projectName} ${session.title} ${session.projectLabel ?? ""}`.toLocaleLowerCase().includes(needle))),
    order.threadSort,
  // `liveKey` stands for the two sets the filter reads.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  ), [threads, lineage.parents, liveKey, projectFilter, needle, order.threadSort]);
  const sections = useMemo(
    () => organizer
      ? organizer.sections(matching)
      : defaultRailSections(matching, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf),
    // The organizer's version says when the same threads would land elsewhere.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [matching, organizer, organizerVersion, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf],
  );
  const mainIndex = Math.max(0, sections.findIndex((section) => !section.label));
  const main = sections[mainIndex] ?? { id: "active", threads: [] };
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

  const activityFor = (sessionId: string): { activity: ThreadActivity; label?: string; hint?: string } => {
    // A stalled question outranks every other state: nothing moves until it is answered.
    if (activity.waiting.has(sessionId)) return { activity: "waiting", label: "Needs you" };
    // Run state follows the thread, not the tab you happen to be reading.
    if (activity.running.has(sessionId)) return { activity: "working", label: "Working" };
    // A provider limit stopped the thread; it continues now, at the reset, or with the next message.
    if (activity.limited.has(sessionId)) {
      return { activity: "limited", label: "Limited", hint: limitHint(threadStore.getThread(sessionId)?.limit) };
    }
    // The last turn failed or its message was refused; the next run clears it.
    if (activity.failed.has(sessionId)) {
      return { activity: "failed", label: "Failed", hint: threadStore.getThread(sessionId)?.turnError ?? "The last message did not reach the agent." };
    }
    // A turn the host never finished because it restarted. The next prompt clears it.
    if (activity.interrupted.has(sessionId)) {
      return { activity: "interrupted", label: "Interrupted", hint: "A restart cut this thread's turn short. Send a message to pick it back up." };
    }
    // A tool still marked running while nothing is in flight is a dead turn, not work.
    if (sessionId === activityState.activeThreadId && activityState.runningToolName) {
      return { activity: "stalled", label: "Interrupted" };
    }
    // Ready means "finished while you were elsewhere"; opening the thread clears it.
    if (activity.unread.has(sessionId)) return { activity: "ready", label: "Ready" };
    return { activity: "idle", label: "Idle" };
  };

  const toggleSettled = useCallback((session: UiSession) => {
    if (organizer) organizer.toggleSettled(session);
    else preferences.toggleSettled(session.id);
  }, [organizer, preferences]);

  const rowActions = useMemo(() => organizer?.rowActions ? (session: UiSession) => organizer.rowActions!(session) : undefined, [organizer]);
  const runRowAction = useCallback((session: UiSession, itemId: string) => organizer?.runMenu(session, itemId, actions), [actions, organizer]);

  const renderRow = (session: UiSession, status: ThreadActivity, label?: string, hint?: string, compact = false) => (
    <ConnectedThreadRow
      key={session.id}
      id={session.id}
      active={session.id === activityState.activeThreadId}
      activity={status}
      activityLabel={label}
      activityHint={hint}
      compact={(compact || compactRows) && status !== "settled"}
      workingChildren={lineage.workingChildren[session.id] ?? 0}
      modelProvider={session.id === activityState.activeThreadId ? snapshot?.model?.provider : undefined}
      startedAt={activityState.runningStartedAt[session.id]}
      rowActions={rowActions}
      onRowAction={runRowAction}
      onSelect={actions.switchSession}
      onToggleSettled={toggleSettled}
    />
  );

  const shelfRows = (section: ThreadRailSection) => {
    const open = !section.shelf || (shelfOpen[section.id] ?? !section.collapsed);
    const limit = shelfLimits[section.id] ?? THREAD_PAGE_SIZE;
    return open ? section.threads.slice(0, limit) : [];
  };

  /** Every row on screen, top to bottom: what the arrow keys walk and a shift-click spans. */
  const orderIds = [
    ...sections.slice(0, mainIndex).flatMap(shelfRows).map((session) => session.id),
    ...navigationRows.flatMap((row) => row.kind === "thread" ? [row.id] : []),
    ...sections.slice(mainIndex + 1).flatMap(shelfRows).map((session) => session.id),
  ];
  const cursorId = orderIds.length ? orderIds[navigationIndex % orderIds.length] : undefined;
  const selected = selectedInOrder(selection, orderIds);

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

  const renderSection = (section: ThreadRailSection): ReactNode => {
    // An empty section shows its heading only while a thread could be dropped on it.
    if (section.threads.length === 0 && !drag) return null;
    const open = !section.shelf || (shelfOpen[section.id] ?? !section.collapsed);
    const rows = shelfRows(section);
    const heading = `${section.label} · ${section.threads.length}`;
    const target = drag?.drop?.sectionId === section.id ? " drop-target" : "";
    return (
      <section key={section.id} className={`${section.shelf ? "settled-shelf" : "rail-section"} rail-section-${section.id}`}>
        {section.shelf ? (
          <button
            className={`settled-shelf-toggle${target}`}
            data-rail-heading={section.id}
            aria-expanded={open}
            onClick={() => setShelfOpen((current) => ({ ...current, [section.id]: !open }))}
          >
            {heading}<i />
            <b>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</b>
          </button>
        ) : <div className={`thread-group-label${target}`} data-rail-heading={section.id}>{heading}<i /></div>}
        {rows.map((session, index) => {
          const status = section.settled ? { activity: "settled" as const } : activityFor(session.id);
          return (
            <div key={session.id} className={rowClass(section.id, session.id, index === rows.length - 1)} {...rowData(section.id, session.id)}>
              {renderRow(session, status.activity, status.label, status.hint, Boolean(section.shelf))}
            </div>
          );
        })}
        {open && rows.length < section.threads.length ? (
          <ShowMoreThreadRow
            remaining={section.threads.length - rows.length}
            onClick={() => setShelfLimits((current) => ({ ...current, [section.id]: Math.min(section.threads.length, rows.length + THREAD_PAGE_SIZE) }))}
          />
        ) : null}
      </section>
    );
  };

  const findSession = (id: string) => sections.flatMap((section) => section.threads).find((session) => session.id === id);
  const clearSelection = () => setSelection((current) => current.ids.size ? { ids: new Set(), ...(current.anchor ? { anchor: current.anchor } : {}) } : current);

  const openMenu = (event: ReactMouseEvent) => {
    if (!organizer) return;
    const id = rowIdOf(event.target) ?? (event.target === event.currentTarget ? cursorId : undefined);
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
    void openContextMenu(event, organizer.menu(session)).then((choice) => { if (choice) organizer.runMenu(session, choice, actions); });
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
          <label className="thread-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
              placeholder="Search"
              aria-label="Search threads"
            />
            {threadQuery ? (
              <button aria-label="Clear thread search" onClick={() => { setThreadQuery(""); searchRef.current?.focus(); }}><X size={13} /></button>
            ) : <kbd className="keyboard-hint">/</kbd>}
          </label>
          <button
            className="sidebar-action"
            {...tooltipProps(readOnlyDevice ? READ_ONLY_REASON : "New thread", { side: "bottom", ...(readOnlyDevice ? {} : { shortcut: registry.keybindingLabel("runtime.new-session") }) })}
            aria-label="New thread"
            disabled={readOnlyDevice}
            onClick={() => actions.newSession()}
          >
            <SquarePen size={16} />
          </button>
        </div>
        <ProjectScope actions={actions} />
      </div>

      <nav
        ref={listRef}
        className={`session-list${drag ? " rail-dragging" : ""}`}
        aria-label="Threads"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onClickCapture={(event) => {
          const target = event.target as Element;
          const id = rowIdOf(target);
          if (!id || target.closest(".thread-row-actions")) return;
          // As in T3 Code: mod-click picks rows, shift-click picks the run from the last one.
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            setSelection((current) => event.shiftKey ? selectRange(current, id, orderIds, activityState.activeThreadId) : toggleSelected(current, id));
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
          if (event.key === "Enter") { void actions.switchSession(findSession(orderIds[current]!)?.path ?? ""); return; }
          const next = (current + (event.key === "ArrowDown" ? 1 : -1) + orderIds.length) % orderIds.length;
          setNavigationIndex(next);
          // Shift and an arrow grow the selection from where it began; a plain arrow moves where it begins.
          if (event.shiftKey) setSelection((selectionNow) => selectRange(selectionNow.anchor ? selectionNow : { ...selectionNow, anchor: orderIds[current]! }, orderIds[next]!, orderIds));
          else setSelection((selectionNow) => selectionNow.ids.size ? selectionNow : { ids: selectionNow.ids, anchor: orderIds[next]! });
        }}
      >
        {sections.slice(0, mainIndex).map(renderSection)}
        {main.label === undefined && drag && sections.length > 1 ? (
          <div className={`thread-group-label rail-main-label${drag.drop?.sectionId === main.id ? " drop-target" : ""}`} data-rail-heading={main.id}>Active<i /></div>
        ) : null}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}>
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
                {...(threadRow ? rowData(main.id, row.id) : {})}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="thread-group-label">{row.label} · {row.count}<i /></div>
                ) : row.kind === "more" ? (
                  <ShowMoreThreadRow remaining={row.remaining} all onClick={() => setOpenGroups((current) => new Set([...current, row.key]))} />
                ) : (() => {
                  const status = activityFor(row.session.id);
                  return renderRow(row.session, status.activity, status.label, status.hint);
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

        {matching.length === 0 ? (
          <p className="sidebar-empty">{threadQuery ? "No threads found" : projectFilter ? `No threads in ${projectFilter}` : "No recent threads"}</p>
        ) : null}

        {sections.slice(mainIndex + 1).map(renderSection)}
      </nav>

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
      <div className="sidebar-footer">
        <button {...tooltipProps("Settings", { side: "top", shortcut: registry.keybindingLabel("runtime.settings") })} aria-label="Settings" onClick={() => actions.openSettings()}>
          <Settings size={15} />
        </button>
        {registry.getCommandsFor("sidebar-footer").slice().sort((a, b) => a.label.localeCompare(b.label)).map((command) => (
          <button
            key={command.id}
            type="button"
            {...tooltipProps(readOnlyDevice && command.access !== "read" ? READ_ONLY_REASON : command.label, { side: "top" })}
            aria-label={command.label}
            disabled={readOnlyDevice && command.access !== "read"}
            onClick={() => { void registry.executeCommand(command.id, actions).catch((error) => actions.notify(String(error))); }}
          >
            {command.Icon ? <command.Icon size={15} /> : command.label}
          </button>
        ))}
      </div>
    </aside>
  );
});
