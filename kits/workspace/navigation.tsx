import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, ChevronDown, ChevronRight, Folder, FolderPlus, Search, Settings, SquarePen, X } from "lucide-react";
import {
  ThreadRow,
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
import { WORKSPACE_HOST_EXTENSION_ID, type UiDirectoryListing } from "./protocol.js";
import { useWorkspaceStore } from "./store-context.js";

export const WORKSPACE_EXTENSION_ID = WORKSPACE_HOST_EXTENSION_ID;

const ROW_STRIDE = 94;
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
 * Threads an agent spawned are never in the rail — not in the settled shelf,
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
): UiSession[] {
  return sessions.filter((session) => !(parents[session.id] ?? session.parentThreadId));
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
  const host = useWorkspaceStore().host;
  const [listing, setListing] = useState<UiDirectoryListing>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const directories = useMemo(() => listing?.directories.filter((entry) => fuzzyMatch(entry.name, query.trim())) ?? [], [listing, query]);

  const load = useCallback(async (path?: string) => {
    try {
      setError(undefined);
      setListing(await host.listDirectories(path));
      setQuery("");
      setSelected(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (nextError) {
      setError(String(nextError));
    }
  }, [host]);
  useEffect(() => { void load(); }, [load]);

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
  const host = useWorkspaceStore().host;
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = repositoryUrl.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const cloned = await host.clone(repositoryUrl.trim());
      if (cloned && await actions.openWorkspace(cloned.workspaceId)) onDone();
    } catch (error) {
      actions.notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="clone-project-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>
        <span>GIT REPOSITORY URL</span>
        <input autoFocus value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/acme/project.git" disabled={busy} />
        <small>HTTPS and SSH clone URLs are accepted. Next, choose the parent folder.</small>
      </label>
      <div className="clone-project-actions">
        <button type="button" onClick={onBack} disabled={busy}>Back</button>
        <button type="submit" className="primary" disabled={!canSubmit}>{busy ? "Cloning…" : "Choose destination"}</button>
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
          title="Add project"
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
  compact,
  workingChildren,
  modelProvider,
  startedAt,
  onSelect,
}: {
  id: string;
  active: boolean;
  activity: ThreadActivity;
  activityLabel?: string;
  compact: boolean;
  workingChildren: number;
  modelProvider?: string;
  startedAt?: number;
  onSelect(path: string): Promise<boolean>;
}) {
  const store = useThreadStore();
  const preferences = usePreferences();
  const session = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(id, listener), [id, store]),
    useCallback(() => store.getThread(id), [id, store]),
  );
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const showCosts = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot).showCosts;
  if (!session) return null;
  return (
    <ThreadRow
      session={session}
      showCost={showCosts}
      projectIcon={findProjectForSession(projects, session)?.icon}
      active={active}
      age={sessionAge(session.modifiedAt)}
      activity={activity}
      activityLabel={activityLabel}
      compact={compact}
      workingChildren={workingChildren}
      modelProvider={modelProvider}
      startedAt={startedAt}
      onSelect={onSelect}
      onToggleSettled={(threadId) => preferences.toggleSettled(threadId)}
    />
  );
});

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const lineage = registry.getThreadLineage();
  const threadStore = useThreadStore();
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
  const [settledOpen, setSettledOpen] = useState(true);
  const [settledLimit, setSettledLimit] = useState(THREAD_PAGE_SIZE);
  const [navigationIndex, setNavigationIndex] = useState(0);
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
  const matching = visibleThreads(threads, lineage.parents)
    .filter(
      (session) =>
        !needle ||
        `${session.projectName} ${session.title} ${session.projectLabel ?? ""}`.toLocaleLowerCase().includes(needle),
    )
    .slice()
    .sort((left, right) => {
      const pinOrder = Number(settings.pinnedThreadIds.includes(right.id)) - Number(settings.pinnedThreadIds.includes(left.id));
      return pinOrder || right.modifiedAt - left.modifiedAt;
    });
  const settledIds = new Set(settings.settledThreadIds);
  const activeThreads = matching.filter((session) => !settledIds.has(session.id) || !showSettledShelf);
  const settledThreads = showSettledShelf ? matching.filter((session) => settledIds.has(session.id)) : [];
  const visibleActive = activeThreads.slice(0, threadLimit);

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

  const activityFor = (sessionId: string): { activity: ThreadActivity; label?: string } => {
    // A stalled question outranks every other state: nothing moves until it is answered.
    if (activityState.waitingThreadIds.includes(sessionId)) return { activity: "waiting", label: "NEEDS YOU" };
    // Run state follows the thread, not the tab you happen to be reading.
    if (activityState.runningThreadIds.includes(sessionId)) {
      return { activity: "working", label: "WORKING" };
    }
    // A tool still marked running while nothing is in flight is a dead turn, not work.
    if (sessionId === activityState.activeThreadId && activityState.runningToolName) {
      return { activity: "stalled", label: "INTERRUPTED" };
    }
    // Ready means "finished while you were elsewhere"; opening the thread clears it.
    if (activityState.unreadThreadIds.includes(sessionId)) return { activity: "ready", label: "READY" };
    return { activity: "idle", label: "IDLE" };
  };

  const renderRow = (session: UiSession, activity: ThreadActivity, label?: string) => (
    <ConnectedThreadRow
      key={session.id}
      id={session.id}
      active={session.id === activityState.activeThreadId}
      activity={activity}
      activityLabel={label}
      compact={compactRows && activity !== "settled"}
      workingChildren={lineage.workingChildren[session.id] ?? 0}
      modelProvider={session.id === activityState.activeThreadId ? snapshot?.model?.provider : undefined}
      startedAt={activityState.runningStartedAt[session.id]}
      onSelect={actions.switchSession}
    />
  );

  const visibleSettled = settledThreads.slice(0, settledLimit);

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
            title="New thread (⌘N)"
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
        className="session-list"
        aria-label="Threads"
        tabIndex={0}
        onKeyDown={(event) => {
          const choices = [...navigationRows.flatMap((row) => row.kind === "thread" ? [row.session] : []), ...(settledOpen ? visibleSettled : [])];
          if (!choices.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Enter") { void actions.switchSession(choices[navigationIndex % choices.length].path); return; }
          setNavigationIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
        }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}>
          {rowVirtualizer.getVirtualItems().map((item) => {
            const row = navigationRows[item.index];
            if (!row) return null;
            return (
              <div
                key={row.id}
                ref={rowVirtualizer.measureElement}
                data-index={item.index}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="thread-group-label">{row.label.toUpperCase()} · {row.count}<i /></div>
                ) : (() => {
                  const status = activityFor(row.session.id);
                  return renderRow(row.session, status.activity, status.label);
                })()}
              </div>
            );
          })}
        </div>

        {visibleActive.length < activeThreads.length ? (
          <ShowMoreThreadRow
            remaining={activeThreads.length - visibleActive.length}
            onClick={() => setThreadLimit((limit) => Math.min(activeThreads.length, limit + THREAD_PAGE_SIZE))}
          />
        ) : null}

        {matching.length === 0 ? (
          <p className="sidebar-empty">{threadQuery ? "No threads found" : "No recent threads"}</p>
        ) : null}

        {settledThreads.length > 0 ? (
          <section className="settled-shelf">
            <button
              className="settled-shelf-toggle"
              aria-expanded={settledOpen}
              onClick={() => setSettledOpen((open) => !open)}
            >
              SETTLED · {settledThreads.length}<i />
              <b>{settledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</b>
            </button>
            {settledOpen ? visibleSettled.map((session) => renderRow(session, "settled")) : null}
            {settledOpen && visibleSettled.length < settledThreads.length ? (
              <ShowMoreThreadRow
                remaining={settledThreads.length - visibleSettled.length}
                onClick={() => setSettledLimit((limit) => Math.min(settledThreads.length, limit + THREAD_PAGE_SIZE))}
              />
            ) : null}
          </section>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button title="Settings" aria-label="Settings" onClick={() => actions.openSettings()}>
          <Settings size={15} />
        </button>
      </div>
    </aside>
  );
});
