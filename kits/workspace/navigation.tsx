import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ChevronDown, ChevronRight, Folder, FolderPlus, Search, Settings, SquarePen, X } from "lucide-react";
import {
  Popover,
  ThreadRow,
  tooltipProps,
  useContextMenu,
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
import { useWorkspaceStore } from "./store-context.js";

export const WORKSPACE_EXTENSION_ID = WORKSPACE_HOST_EXTENSION_ID;

const ROW_STRIDE = 78;
const THREAD_PAGE_SIZE = 25;

type NavigationRow =
  | { kind: "group"; id: string; label: string; count: number }
  | { kind: "thread"; id: string; session: UiSession };

function ShowMoreThreadRow({ remaining, onClick }: { remaining: number; onClick(): void }) {
  const count = Math.min(THREAD_PAGE_SIZE, remaining);
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

export function LocalFolderSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const store = useWorkspaceStore();
  const host = store.host;
  const [listing, setListing] = useState<UiDirectoryListing>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const directories = useMemo(() => listing?.directories.filter((entry) => fuzzyMatch(entry.name, query.trim())) ?? [], [listing, query]);

  const load = useCallback(async (path?: string, fallBack = false) => {
    try {
      setError(undefined);
      setListing(await host.listDirectories(path).catch((failure: unknown) => {
        // A base folder that is gone opens the home folder instead of an error.
        if (fallBack) return host.listDirectories();
        throw failure;
      }));
      setQuery("");
      setSelected(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (nextError) {
      setError(String(nextError));
    }
  }, [host]);
  useEffect(() => {
    const base = store.projectBaseDirectory();
    void load(base, base !== undefined);
  }, [load, store]);

  const addCurrent = async () => {
    if (!listing) return;
    if (await actions.openWorkspace(listing.workspace.workspaceId)) onDone();
  };
  const openSelected = () => {
    const directory = directories[selected];
    if (directory) void load(directory.path);
  };

  return <div className="folder-browser">
    <div className="folder-browser-path">
      <button type="button" onClick={onBack} aria-label="Back to project sources"><ArrowLeft size={16} /></button>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(value + 1, Math.max(0, directories.length - 1))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
          if (event.key === "Enter") { event.preventDefault(); openSelected(); }
          if (event.key === "Backspace" && !query && listing?.parent) { event.preventDefault(); void load(listing.parent); }
        }}
        placeholder={listing?.path ?? "Loading folders…"}
        aria-label="Filter folders"
      />
      <button type="button" className="folder-add" onClick={() => void addCurrent()}>Add <kbd>Enter</kbd></button>
    </div>
    <div className="folder-browser-heading">Directories <small>{listing?.path}</small></div>
    <div className="folder-browser-results" role="listbox">
      {listing?.parent ? <button type="button" onClick={() => void load(listing.parent)}><ArrowLeft size={15} /><span>..</span></button> : null}
      {directories.map((directory, index) => <button
        type="button"
        role="option"
        aria-selected={selected === index}
        className={selected === index ? "selected" : ""}
        key={directory.path}
        onMouseMove={() => setSelected(index)}
        onClick={() => void load(directory.path)}
      ><Folder size={16} /><span>{directory.name}</span></button>)}
      {directories.length === 0 && listing ? <p>No matching directories</p> : null}
      {error ? <p className="folder-browser-error">{error}</p> : null}
    </div>
    <footer><span><kbd>↑↓</kbd> Navigate</span><span><kbd>Backspace</kbd> Back</span><span><kbd>Esc</kbd> Close</span></footer>
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
      <label>
        <span>Git repository URL</span>
        <input autoFocus value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/acme/project.git" disabled={busy} />
        <small>HTTPS and SSH clone URLs are accepted. The clone runs in the background; a notice shows its progress and can cancel it.</small>
      </label>
      <div className="clone-project-destination">
        <span>Clone into</span>
        {base
          ? <code title={base}>{`${base.replace(/[\\/]+$/u, "")}/${url ? repositoryFolderName(url) : "…"}`}</code>
          : <small>A folder you choose next. Settings → Source control → New projects sets a default.</small>}
      </div>
      <div className="clone-project-actions">
        <button type="button" onClick={onBack} disabled={busy}>Back</button>
        {base ? <button type="button" disabled={!canSubmit} onClick={() => void submit(false)}>Choose another folder…</button> : null}
        <button type="submit" className="primary" disabled={!canSubmit}>{busy ? "Starting…" : base ? "Clone" : "Choose destination"}</button>
      </div>
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
}: {
  activePath?: string;
  open: boolean;
  projects: readonly UiProject[];
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
          if (event.key === "Escape") onClose();
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
          <i className={project.icon ? "has-image" : ""}>
            {project.icon ? <img src={project.icon} alt="" aria-hidden="true" /> : projectInitial(project.name)}
          </i>
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
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const [searchOpen, setSearchOpen] = useState(false);

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
          <span>All projects</span>
          <b><ChevronDown size={14} /></b>
        </button>
        <button
          className="sidebar-action"
          {...tooltipProps("Add project", { side: "bottom" })}
          aria-label="Add project"
          onClick={() => { setSearchOpen(false); actions.openProjectSources(); }}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <ProjectSwitcherPopover
        activePath={activeProject?.path ?? snapshot?.cwd}
        open={searchOpen}
        projects={projects}
        onClose={() => setSearchOpen(false)}
        onSelect={(project) => { setSearchOpen(false); void actions.openWorkspace(project.path); }}
      />
    </>
  );
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
  const showCosts = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot).showCosts;
  const workspace = useWorkspaceStore();
  const accessories = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowAccessories);
  const project = session ? session.workspaceId ?? session.projectPath : undefined;
  const defaultBranch = useSyncExternalStore(workspace.subscribe, () => project ? workspace.getSnapshot().defaultBranches[project] : undefined);
  useEffect(() => { if (project) workspace.loadDefaultBranch(project); }, [project, workspace]);
  if (!session) return null;
  const offered = activity === "settled" ? [] : rowActions?.(session) ?? [];
  return (
    <ThreadRow
      session={session}
      showLabel={!isDefaultBranch(session.projectLabel, defaultBranch)}
      actions={offered.length > 0
        ? offered.map((action) => <RailRowAction key={action.id} action={action} onPick={(itemId) => onRowAction(session, itemId)} />)
        : undefined}
      accessory={accessories.length > 0 ? accessories.map((Accessory, index) => <Accessory key={index} session={session} />) : undefined}
      showCost={showCosts}
      projectIcon={findProjectForSession(projects, session)?.icon}
      active={active}
      age={sessionAge(session.modifiedAt)}
      activity={activity}
      activityLabel={activityLabel}
      activityHint={activityHint}
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

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const lineage = registry.getThreadLineage();
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const organizer = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRailOrganizer);
  useSyncExternalStore(organizer?.subscribe ?? noSubscription, organizer?.getVersion ?? noVersion);
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
  const [navigationIndex, setNavigationIndex] = useState(0);
  const openContextMenu = useContextMenu();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const option = (id: string, fallback: boolean) =>
    settings.extensionOptions[`${WORKSPACE_EXTENSION_ID}.${id}`] ?? fallback;
  const groupByProject = option("group-by-project", false);
  const showSettledShelf = option("show-settled", true);
  const compactRows = option("compact-rows", false);

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

  const needle = threadQuery.trim().toLocaleLowerCase();
  const live = (id: string) => activityState.runningThreadIds.includes(id) || activityState.waitingThreadIds.includes(id);
  const matching = visibleThreads(threads, lineage.parents, live)
    .filter(
      (session) =>
        !needle ||
        `${session.projectName} ${session.title} ${session.projectLabel ?? ""}`.toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const sections = organizer
    ? organizer.sections(matching)
    : defaultRailSections(matching, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf);
  const mainIndex = Math.max(0, sections.findIndex((section) => !section.label));
  const main = sections[mainIndex] ?? { id: "active", threads: [] };
  const visibleActive = main.threads.slice(0, threadLimit);
  const { drag, onPointerDown } = useRailDrag(organizer, sections);

  const navigationRows: NavigationRow[] = groupByProject
    ? [...visibleActive.reduce((groups, session) => {
        const group = groups.get(session.projectName);
        if (group) group.push(session);
        else groups.set(session.projectName, [session]);
        return groups;
      }, new Map<string, UiSession[]>())].flatMap(([project, sessions]) => [
        { kind: "group" as const, id: `group:${project}`, label: project, count: sessions.length },
        ...sessions.map((session) => ({ kind: "thread" as const, id: session.id, session })),
      ])
    : visibleActive.map((session) => ({ kind: "thread" as const, id: session.id, session }));
  const rowVirtualizer = useVirtualizer({
    count: navigationRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => navigationRows[index]?.kind === "group" ? 28 : ROW_STRIDE,
    getItemKey: (index) => navigationRowKey(navigationRows, index),
    overscan: 6,
  });

  const activityFor = (sessionId: string): { activity: ThreadActivity; label?: string; hint?: string } => {
    // A stalled question outranks every other state: nothing moves until it is answered.
    if (activityState.waitingThreadIds.includes(sessionId)) return { activity: "waiting", label: "Needs you" };
    // Run state follows the thread, not the tab you happen to be reading.
    if (activityState.runningThreadIds.includes(sessionId)) {
      return { activity: "working", label: "Working" };
    }
    // The last turn failed or its message was refused; the next run clears it.
    if (activityState.failedThreadIds.includes(sessionId)) {
      return { activity: "failed", label: "Failed", hint: threadStore.getThread(sessionId)?.turnError ?? "The last message did not reach the agent." };
    }
    // A turn the host never finished because it restarted. The next prompt clears it.
    if (activityState.interruptedThreadIds.includes(sessionId)) {
      return { activity: "interrupted", label: "Interrupted", hint: "A restart cut this thread's turn short. Send a message to pick it back up." };
    }
    // A tool still marked running while nothing is in flight is a dead turn, not work.
    if (sessionId === activityState.activeThreadId && activityState.runningToolName) {
      return { activity: "stalled", label: "Interrupted" };
    }
    // Ready means "finished while you were elsewhere"; opening the thread clears it.
    if (activityState.unreadThreadIds.includes(sessionId)) return { activity: "ready", label: "Ready" };
    return { activity: "idle", label: "Idle" };
  };

  const toggleSettled = useCallback((session: UiSession) => {
    if (organizer) organizer.toggleSettled(session);
    else preferences.toggleSettled(session.id);
  }, [organizer, preferences]);

  const rowActions = useMemo(() => organizer?.rowActions ? (session: UiSession) => organizer.rowActions!(session) : undefined, [organizer]);
  const runRowAction = useCallback((session: UiSession, itemId: string) => organizer?.runMenu(session, itemId, actions), [actions, organizer]);

  const renderRow = (session: UiSession, activity: ThreadActivity, label?: string, hint?: string, compact = false) => (
    <ConnectedThreadRow
      key={session.id}
      id={session.id}
      active={session.id === activityState.activeThreadId}
      activity={activity}
      activityLabel={label}
      activityHint={hint}
      compact={(compact || compactRows) && activity !== "settled"}
      workingChildren={lineage.workingChildren[session.id] ?? 0}
      modelProvider={session.id === activityState.activeThreadId ? snapshot?.model?.provider : undefined}
      startedAt={activityState.runningStartedAt[session.id]}
      rowActions={rowActions}
      onRowAction={runRowAction}
      onSelect={actions.switchSession}
      onToggleSettled={toggleSettled}
    />
  );

  /** A row's wrapper carries what the drag and the menu read; the classes show where a drop lands. */
  const rowClass = (sectionId: string, id: string, last: boolean): string => {
    const classes = ["rail-row"];
    if (drag?.threadId === id) classes.push("dragging");
    if (drag?.drop?.sectionId === sectionId) {
      if (drag.drop.beforeThreadId === id) classes.push("drop-before");
      else if (last && !drag.drop.beforeThreadId) classes.push("drop-after");
    }
    return classes.join(" ");
  };

  const shelfRows = (section: ThreadRailSection) => {
    const open = !section.shelf || (shelfOpen[section.id] ?? !section.collapsed);
    const limit = shelfLimits[section.id] ?? THREAD_PAGE_SIZE;
    return open ? section.threads.slice(0, limit) : [];
  };

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
            <div key={session.id} className={rowClass(section.id, session.id, index === rows.length - 1)} data-rail-thread={session.id} data-rail-section={section.id}>
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
            ) : <kbd>/</kbd>}
          </label>
          <button
            className="sidebar-action"
            {...tooltipProps("New thread", { side: "bottom", shortcut: registry.keybindingLabel("runtime.new-session") })}
            aria-label="New thread"
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
        onContextMenu={(event) => {
          if (!organizer) return;
          const id = (event.target as Element).closest<HTMLElement>("[data-rail-thread]")?.dataset.railThread;
          const session = id ? findSession(id) : undefined;
          if (!session) return;
          // The OS draws it where it can; the page draws its own elsewhere.
          void openContextMenu(event, organizer.menu(session)).then((choice) => { if (choice) organizer.runMenu(session, choice, actions); });
        }}
        onKeyDown={(event) => {
          // A row's own buttons and their popovers keep their keys.
          const target = event.target as Element;
          if (!event.currentTarget.contains(target) || target.closest(".thread-row-actions")) return;
          const choices = [
            ...sections.slice(0, mainIndex).flatMap(shelfRows),
            ...navigationRows.flatMap((row) => row.kind === "thread" ? [row.session] : []),
            ...sections.slice(mainIndex + 1).flatMap(shelfRows),
          ];
          if (!choices.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Enter") { void actions.switchSession(choices[navigationIndex % choices.length].path); return; }
          setNavigationIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
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
                {...(threadRow ? { "data-rail-thread": row.id, "data-rail-section": main.id } : {})}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="thread-group-label">{row.label} · {row.count}<i /></div>
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
          <p className="sidebar-empty">{threadQuery ? "No threads found" : "No recent threads"}</p>
        ) : null}

        {sections.slice(mainIndex + 1).map(renderSection)}
      </nav>

      {drag?.label ? <div className="rail-drag-label" style={{ left: drag.x + 14, top: drag.y + 10 }}>{drag.label}</div> : null}
      {organizer?.Layer ? <organizer.Layer actions={actions} /> : null}

      <div className="sidebar-footer">
        <button {...tooltipProps("Settings", { side: "top", shortcut: registry.keybindingLabel("runtime.settings") })} aria-label="Settings" onClick={() => actions.openSettings()}>
          <Settings size={15} />
        </button>
      </div>
    </aside>
  );
});
