import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Search, Settings, SquarePen, X } from "lucide-react";
import type { UiSession } from "../../shared/contracts";
import type {
  ContributionOwner,
  ProjectSourceContribution,
  ProjectSourceProps,
  SidebarContributionProps,
} from "../extension-system";
import { preferences } from "../preferences";
import { useThreadStore, useWorkbenchShell } from "../workbench-context";
import { ProjectPicker } from "../components/ProjectPicker";
import { ThreadRow, type ThreadActivity } from "../components/ThreadRow";

export const WORKSPACE_EXTENSION_ID = "tau.workspace";

const ROW_STRIDE = 94;

type NavigationRow =
  | { kind: "group"; id: string; label: string; count: number }
  | { kind: "thread"; id: string; session: UiSession };

export function navigationRowKey(rows: readonly NavigationRow[], index: number): string | number {
  return rows[index]?.id ?? index;
}

function projectName(cwd?: string): string {
  return cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace";
}

function AddProjectModal({
  actions,
  onClose,
  sources,
}: {
  actions: SidebarContributionProps["actions"];
  onClose(): void;
  sources: Array<ProjectSourceContribution & ContributionOwner>;
}) {
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [busySourceId, setBusySourceId] = useState<string>();
  const activeSource = sources.find((source) => source.id === activeSourceId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (activeSourceId) setActiveSourceId(undefined);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSourceId, onClose]);

  const selectSource = async (source: ProjectSourceContribution) => {
    if (source.Component) {
      setActiveSourceId(source.id);
      return;
    }
    setBusySourceId(source.id);
    try {
      const completed = await source.run(actions);
      if (completed !== false) onClose();
    } finally {
      setBusySourceId(undefined);
    }
  };

  const SourceComponent = activeSource?.Component;
  return (
    <>
      <button className="project-modal-scrim" aria-label="Close add project" onClick={onClose} />
      <section className="project-modal" role="dialog" aria-modal="true" aria-label="Add project">
        <header className="project-modal-title">
          <button className="modal-back" disabled={!SourceComponent} onClick={() => setActiveSourceId(undefined)}>←</button>
          <span>
            <small>{SourceComponent ? "Project source" : "Workspace extension"}</small>
            <strong>{activeSource?.label ?? "Add project"}</strong>
          </span>
          <button className="modal-close" onClick={onClose}>esc</button>
        </header>
        {SourceComponent ? (
          <SourceComponent actions={actions} onBack={() => setActiveSourceId(undefined)} onDone={onClose} />
        ) : (
          <>
            <div className="project-source-intro">
              <span>CHOOSE A SOURCE</span>
              <p>Each source comes from a desktop extension. Tau only owns the modal slot.</p>
            </div>
            <div className="project-source-list">
              {sources.map((source) => (
                <button key={source.id} disabled={Boolean(busySourceId)} onClick={() => void selectSource(source)}>
                  <i>{source.glyph}</i>
                  <span><strong>{source.label}</strong><small>{source.description}</small></span>
                  <b>{busySourceId === source.id ? "working…" : "→"}</b>
                </button>
              ))}
              {sources.length === 0 ? <p>No project sources are registered.</p> : null}
            </div>
          </>
        )}
      </section>
    </>
  );
}

export function CloneProjectSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const canSubmit = repositoryUrl.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const completed = await actions.cloneWorkspace(repositoryUrl.trim());
    setBusy(false);
    if (completed) onDone();
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

function ProjectScope({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const projectSources = useMemo(() => registry.getProjectSources(), [registry, addOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      setAddOpen(false);
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <div className="project-scope-row">
        <button className="project-scope" onClick={() => { setAddOpen(false); setSearchOpen(true); }}>
          <i className="all-projects-icon"><Folder size={15} /></i>
          <span>All projects</span>
          <b><ChevronDown size={14} /></b>
        </button>
        <button
          className="sidebar-action"
          title="Add project"
          aria-label="Add project"
          onClick={() => { setSearchOpen(false); setAddOpen(true); }}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <ProjectPicker
        activePath={snapshot?.cwd}
        open={searchOpen}
        projects={projects}
        onBrowse={() => { setSearchOpen(false); setAddOpen(true); }}
        onClose={() => setSearchOpen(false)}
        onSelect={(project) => { setSearchOpen(false); void actions.openWorkspace(project.path); }}
      />
      {addOpen ? <AddProjectModal actions={actions} onClose={() => setAddOpen(false)} sources={projectSources} /> : null}
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
  onSelect,
}: {
  id: string;
  active: boolean;
  activity: ThreadActivity;
  activityLabel?: string;
  compact: boolean;
  onSelect(path: string): Promise<boolean>;
}) {
  const store = useThreadStore();
  const session = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(id, listener), [id, store]),
    useCallback(() => store.getThread(id), [id, store]),
  );
  if (!session) return null;
  return (
    <ThreadRow
      session={session}
      active={active}
      age={sessionAge(session.modifiedAt)}
      activity={activity}
      activityLabel={activityLabel}
      compact={compact}
      onSelect={onSelect}
      onToggleSettled={(threadId) => preferences.toggleSettled(threadId)}
    />
  );
});

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const [threadQuery, setThreadQuery] = useState("");
  const navigationSnapshot = useSyncExternalStore(
    threadQuery ? threadStore.subscribe : threadStore.subscribeToIds,
    threadStore.getSnapshot,
  );
  const activityState = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const threads = navigationSnapshot.threads;
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [settledOpen, setSettledOpen] = useState(true);
  const [settledLimit, setSettledLimit] = useState(40);
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
  const matching = threads
    .filter(
      (session) =>
        !needle ||
        `${session.projectName} ${session.title} ${session.branch ?? ""}`.toLocaleLowerCase().includes(needle),
    )
    .slice()
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const settledIds = new Set(settings.settledThreadIds);
  const activeThreads = matching.filter((session) => !settledIds.has(session.id) || !showSettledShelf);
  const settledThreads = showSettledShelf ? matching.filter((session) => settledIds.has(session.id)) : [];

  const navigationRows: NavigationRow[] = groupByProject
    ? [...activeThreads.reduce((groups, session) => {
        const group = groups.get(session.projectName);
        if (group) group.push(session);
        else groups.set(session.projectName, [session]);
        return groups;
      }, new Map<string, UiSession[]>())].flatMap(([project, sessions]) => [
        { kind: "group" as const, id: `group:${project}`, label: project, count: sessions.length },
        ...sessions.map((session) => ({ kind: "thread" as const, id: session.id, session })),
      ])
    : activeThreads.map((session) => ({ kind: "thread" as const, id: session.id, session }));
  const rowVirtualizer = useVirtualizer({
    count: navigationRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => navigationRows[index]?.kind === "group" ? 28 : ROW_STRIDE,
    getItemKey: (index) => navigationRowKey(navigationRows, index),
    overscan: 6,
  });

  const activityFor = (sessionId: string): { activity: ThreadActivity; label?: string } => {
    if (sessionId === activityState.activeThreadId) {
      if (activityState.runningToolName) return { activity: "tool", label: activityState.runningToolName.toUpperCase() };
      if (activityState.isStreaming) return { activity: "working", label: "WORKING" };
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
          const choices = [...activeThreads, ...(settledOpen ? visibleSettled : [])];
          if (!choices.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "Enter") { void actions.switchSession(choices[navigationIndex % choices.length].path); return; }
          setNavigationIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
        }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
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

        {matching.length === 0 ? (
          <p className="sidebar-empty">{threadQuery ? "No threads found" : "No recent threads"}</p>
        ) : null}

        {settledThreads.length > 0 ? (
          <section className="settled-shelf">
            <button className="settled-shelf-toggle" onClick={() => setSettledOpen((open) => !open)}>
              SETTLED · {settledThreads.length}<i />
              <b>{settledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</b>
            </button>
            {settledOpen ? visibleSettled.map((session) => renderRow(session, "settled")) : null}
            {settledOpen && visibleSettled.length < settledThreads.length ? (
              <button className="settled-show-more" onClick={() => setSettledLimit((limit) => Math.min(settledThreads.length, limit + 40))}>
                Show more settled threads ({settledThreads.length - visibleSettled.length})
              </button>
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
