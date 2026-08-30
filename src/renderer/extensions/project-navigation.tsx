import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, LayoutGrid, Plus, Search, Settings, X } from "lucide-react";
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
  const threadIndex = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
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
          <i className="all-projects-icon"><LayoutGrid size={13} /></i>
          <span>All projects</span>
          <b><ChevronDown size={12} /></b>
        </button>
        <button className="icon-action" title="Add project" aria-label="Add project" onClick={() => { setSearchOpen(false); setAddOpen(true); }}><Plus size={15} /></button>
      </div>
      <ProjectPicker
        activePath={snapshot?.cwd}
        open={searchOpen}
        projects={threadIndex.projects}
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

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const threadIndex = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [threadQuery, setThreadQuery] = useState("");
  const [settledOpen, setSettledOpen] = useState(true);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: 30 });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const scrollFrameRef = useRef<number | undefined>(undefined);

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
  const matching = threadIndex.threads
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

  const virtualized = !groupByProject && activeThreads.length > 80;
  const updateVirtualRange = useCallback(() => {
    if (!virtualized) {
      setVirtualRange({ start: 0, end: activeThreads.length });
      return;
    }
    const node = listRef.current;
    if (!node) return;
    const overscan = 6;
    const start = Math.min(activeThreads.length, Math.max(0, Math.floor(node.scrollTop / ROW_STRIDE) - overscan));
    const end = Math.min(
      activeThreads.length,
      Math.ceil((node.scrollTop + node.clientHeight) / ROW_STRIDE) + overscan,
    );
    setVirtualRange((current) => current.start === start && current.end === end ? current : { start, end });
  }, [activeThreads.length, virtualized]);

  const handleListScroll = useCallback(() => {
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      updateVirtualRange();
    });
  }, [updateVirtualRange]);

  useEffect(() => {
    updateVirtualRange();
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateVirtualRange);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateVirtualRange]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const activityFor = (sessionId: string): { activity: ThreadActivity; label?: string } => {
    if (sessionId === threadIndex.activeThreadId) {
      if (threadIndex.runningToolName) return { activity: "tool", label: threadIndex.runningToolName.toUpperCase() };
      if (threadIndex.isStreaming) return { activity: "working", label: "WORKING" };
    }
    // Ready means "finished while you were elsewhere"; opening the thread clears it.
    if (threadIndex.unreadThreadIds.includes(sessionId)) return { activity: "ready", label: "READY" };
    return { activity: "idle", label: "IDLE" };
  };

  const renderRow = (session: UiSession, activity: ThreadActivity, label?: string) => (
    <ThreadRow
      key={session.id}
      session={session}
      active={session.id === threadIndex.activeThreadId}
      age={sessionAge(session.modifiedAt)}
      activity={activity}
      activityLabel={label}
      compact={compactRows && activity !== "settled"}
      onSelect={actions.switchSession}
      onToggleSettled={(id) => preferences.toggleSettled(id)}
    />
  );

  const visible = virtualized ? activeThreads.slice(virtualRange.start, virtualRange.end) : activeThreads;
  const grouped = groupByProject
    ? [...visible.reduce((map, session) => {
        const entries = map.get(session.projectName);
        if (entries) entries.push(session);
        else map.set(session.projectName, [session]);
        return map;
      }, new Map<string, UiSession[]>())]
    : [["", visible] as const];

  return (
    <aside className="session-rail">
      <div className="sidebar-controls">
        <ProjectScope actions={actions} />
        <label className="thread-search">
          <Search size={13} />
          <input
            ref={searchRef}
            value={threadQuery}
            onChange={(event) => setThreadQuery(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
          />
          {threadQuery ? (
            <button aria-label="Clear thread search" onClick={() => { setThreadQuery(""); searchRef.current?.focus(); }}><X size={13} /></button>
          ) : <kbd>/</kbd>}
        </label>
      </div>

      <nav ref={listRef} className="session-list" aria-label="Threads" onScroll={handleListScroll}>
        {virtualized && virtualRange.start > 0 ? (
          <div className="thread-virtual-spacer" style={{ height: virtualRange.start * ROW_STRIDE }} aria-hidden />
        ) : null}

        {grouped.map(([group, sessions]) => (
          <div key={group || "all"} style={{ display: "contents" }}>
            {group ? (
              <div className="thread-group-label">
                {group.toUpperCase()} · {sessions.length}
                <i />
              </div>
            ) : null}
            {sessions.map((session) => {
              const status = activityFor(session.id);
              return renderRow(session, status.activity, status.label);
            })}
          </div>
        ))}

        {virtualized && virtualRange.end < activeThreads.length ? (
          <div
            className="thread-virtual-spacer"
            style={{ height: (activeThreads.length - virtualRange.end) * ROW_STRIDE }}
            aria-hidden
          />
        ) : null}

        {matching.length === 0 ? (
          <p className="sidebar-empty">{threadQuery ? "No threads found" : "No recent threads"}</p>
        ) : null}

        {settledThreads.length > 0 ? (
          <section className="settled-shelf">
            <button className="settled-shelf-toggle" onClick={() => setSettledOpen((open) => !open)}>
              SETTLED · {settledThreads.length}<i />
              <b>{settledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</b>
            </button>
            {settledOpen ? settledThreads.map((session) => renderRow(session, "settled")) : null}
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
