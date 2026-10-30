import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArchiveRestore, ArrowLeft, Check, ChevronDown, CircleCheck, Eye, Folder, FolderOpen, GitBranch, MessageSquare, PanelLeft, Plus, Search, Server, SquarePen, Trash2 } from "lucide-react";
import {
  ConfirmDialog,
  DraftRow,
  draftTitle,
  errorMessage,
  findProjectForSession,
  Menu,
  type MenuSection,
  ThreadRow,
  tooltipProps,
  useClientStorage,
  useContextMenu,
  useHostCapabilities,
  usePreferences,
  useProjectIcon,
  useThreadStore,
  useWorkbenchShell,
  type DraftThread,
  type ProjectSourceProps,
  type SidebarContributionProps,
  attentionMarkIds,
  markedRowStatus,
  threadRowStatus,
  type ThreadRowStatus,
  type ThreadActivity,
  type UiProject,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import { repositoryFolderName, WORKSPACE_HOST_EXTENSION_ID, type RailExternalThread, type ThreadRailSection, type ThreadRailOrganizer, type ThreadRailRowAction } from "./protocol.js";
import { homeRelative } from "./folder-finder.js";
import { githubRepositoryName, githubRepositoryPath, isGithubOwner, type RepositoryVisibility } from "./project-github.js";
import { railActivity } from "./rail-activity.js";
import { useRailDrag } from "./rail-drag.js";
import { mergeByTime, useRailExternalThreads } from "./rail-external.js";
import { ThreadCard, ThreadCardLayer, type ThreadCardTarget } from "./thread-card.js";
import { groupThreads, railAnchor, readRailOrder, sortThreads, type RailOrder } from "./rail-order.js";
import { NO_SELECTION, selectRange, selectedInOrder, toggleSelected, type RailSelection } from "./rail-selection.js";
import { projectPromotionMenu, PROMOTE_PROJECT } from "./project-promotion-menu.js";
import { accessoryMarks, diffStat } from "./row-marks.js";
import { useRowAge } from "./row-age.js";
import { useWorkspaceStore } from "./store-context.js";
import { SidebarFooter } from "./sidebar-footer.js";
import { ProjectFilterMenu, RailProjectControls } from "./project-filter-menu.js";
import { NO_PROJECT, projectFilterIncludes, projectFilterLabel, projectId, type RailProjectFilter } from "./project-filter.js";
import { createRailMotion, type RailPlace } from "./rail-motion.js";
import { GROUPS_OPEN_KEY, railKeyDestination, railNavigationId, readRailGroupsOpen, useRailNavigation, type RailNavigationRow } from "./rail-navigation.js";
import { readShelvesOpen, SHELF_PAGE, shelfFirstPage, shelfHeading, shelfIsOpen, shelfRows as rowsOfShelf, writeShelvesOpen, type ShelvesOpen } from "./rail-shelves.js";

export const WORKSPACE_EXTENSION_ID = WORKSPACE_HOST_EXTENSION_ID;

/** A card (70 px, the design's) and the 2 px between two. */
const ROW_STRIDE = 72;
const THREAD_PAGE_SIZE = 25;

export type NavigationRow =
  | { kind: "group"; id: string; label: string; count: number; expanded: boolean; project?: UiProject }
  | { kind: "more"; id: string; key: string; remaining: number }
  | { kind: "thread"; id: string; session: UiSession };

function ShowMoreThreadRow({ remaining, all = false, cursor, onClick }: { remaining: number; all?: boolean; cursor: boolean; onClick(): void }) {
  const count = all ? remaining : Math.min(THREAD_PAGE_SIZE, remaining);
  return (
    <article className="thread-row compact thread-pagination-row">
      <button className="thread-main" tabIndex={cursor ? 0 : -1} onClick={onClick}><Plus size={14} aria-hidden="true" /><span>Show {count} more</span></button>
    </article>
  );
}

/**
 * A thread nobody has written to yet is a draft, not a row,
 * unless it is already at work. Threads an agent spawned are never in the rail — not in the settled shelf,
 * not in a search, not even while one is the thread on screen.
 * Subagents open inside their parent conversation.
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
export function navigationRowsFor(threads: readonly UiSession[], order: RailOrder, projects: readonly UiProject[], openGroups: ReadonlySet<string>, groupsOpen: Readonly<Record<string, boolean>> = {}): NavigationRow[] {
  if (order.grouping === "none") return threads.map((session) => ({ kind: "thread" as const, id: session.id, session }));
  const projectOf = (session: UiSession) => findProjectForSession(projects, session);
  return groupThreads(threads, order.grouping, order.projectSort, projectOf).flatMap((group): NavigationRow[] => {
    const expanded = groupsOpen[`group:${group.key}`] ?? true;
    const shown = !expanded ? [] : openGroups.has(group.key) ? group.threads : group.threads.slice(0, order.preview);
    const project = group.threads[0] ? projectOf(group.threads[0]) : undefined;
    return [
      { kind: "group", id: `group:${group.key}`, label: group.label, count: group.threads.length, expanded, ...(project ? { project } : {}) },
      ...shown.map((session) => ({ kind: "thread" as const, id: session.id, session })),
      ...(expanded && shown.length < group.threads.length ? [{ kind: "more" as const, id: `more:${group.key}`, key: group.key, remaining: group.threads.length - shown.length }] : []),
    ];
  });
}

export function navigationRowKey(rows: readonly NavigationRow[], index: number): string | number {
  return rows[index]?.id ?? index;
}

/**
 * A name and the host's parent folder create a ready project. Ticking GitHub
 * also creates its repository (private unless chosen otherwise) and pushes the
 * first commit, so `main` tracks `origin/main`; that runs on the host that
 * makes the project, and a failure there still leaves the project.
 */
export function NewProjectSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const store = useWorkspaceStore();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState(false);
  const [owner, setOwner] = useState("");
  const [visibility, setVisibility] = useState<RepositoryVisibility>("private");
  const base = store.projectBaseDirectory();
  const repository = githubRepositoryPath(name, owner);
  const ownerValid = !owner.trim() || isGithubOwner(owner.trim());
  const ready = Boolean(name.trim()) && !busy && (!github || (ownerValid && Boolean(repository)));
  const submit = async (useBase: boolean) => {
    if (!ready) return;
    setBusy(true);
    try {
      const created = await store.createProject(name, useBase ? base : undefined, github ? { ...(owner.trim() ? { owner: owner.trim() } : {}), visibility } : undefined);
      if (!created) return;
      if (created.warning) actions.notify(created.warning, "warning");
      else if (created.github) actions.notify(`Created ${created.github.repository} on GitHub and pushed ${created.github.branch ?? "the first commit"}.`, "info");
      if (await actions.openWorkspace(created.workspace.workspaceId)) {
        actions.newSession({ workspace: created.workspace.workspaceId });
        onDone();
      }
    } catch (error) { actions.notify(errorMessage(error), "error"); }
    finally { setBusy(false); }
  };
  return <form className="clone-project-form" onSubmit={(event) => { event.preventDefault(); void submit(Boolean(base)); }}>
    <header className="project-modal-bar">
      <button type="button" className="project-modal-bar-glyph" onClick={onBack} aria-label="Back to project sources"><ArrowLeft size={15} /></button>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" aria-label="Project name" disabled={busy} />
      <button type="submit" className="project-modal-bar-action" disabled={!ready}>{busy ? "Creating…" : base ? "Create" : "Continue"}</button>
    </header>
    <div className="project-picker-heading"><span>Create in</span></div>
    <div className="clone-project-destination"><Folder size={15} />{base ? <code>{homeRelative(base)}/{name.trim() || "…"}</code> : <span>A folder you choose next</span>}</div>
    <div className="new-project-github">
      <label><input type="checkbox" checked={github} disabled={busy} onChange={(event) => setGithub(event.target.checked)} />Create a GitHub repository</label>
      {github ? <div className="new-project-github-options">
        <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Your account" aria-label="GitHub owner" aria-invalid={!ownerValid} spellCheck={false} disabled={busy} />
        <code title={repository}>/{githubRepositoryName(name) || "…"}</code>
        <div className="toggle-group" role="radiogroup" aria-label="Visibility">
          {(["private", "public"] as const).map((next) => (
            <button key={next} type="button" role="radio" aria-checked={visibility === next} className={visibility === next ? "active" : ""} disabled={busy} onClick={() => setVisibility(next)}>{next === "private" ? "Private" : "Public"}</button>
          ))}
        </div>
      </div> : null}
    </div>
    <footer className="project-modal-footer">{base ? <button type="button" disabled={!ready} onClick={() => void submit(false)}><FolderOpen size={14} /> Choose parent folder…</button> : null}<small>{github ? "Starts with a README, pushed to GitHub through gh" : "Starts with a README and Git repository"}</small></footer>
  </form>;
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
      actions.notify(error instanceof Error ? error.message : String(error), "error");
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

export { findProjectForSession } from "tau";

const switcherRequests = new Set<() => void>();

/** Opens the rail's project switcher; the kit's `workspace.switch-project` command, which no chord is bound to by default. */
export function requestProjectSwitcher(): void {
  for (const open of switcherRequests) open();
}

export { rankProjects } from "./project-filter.js";

/** Searchable project switcher shares the filter's project list. */
export function ProjectSwitcherPopover({ activePath, open, projects, onClose, onSelect }: {
  activePath?: string; open: boolean; projects: readonly UiProject[]; onClose(): void; onSelect(project: UiProject): void;
}) {
  const current = findProjectForSession(projects, { projectPath: activePath ?? "" });
  return open ? <ProjectFilterMenu filter={current ? [projectId(current)] : []} groups={[]} projects={projects} hasNoProject={false} onClose={onClose} onPick={onSelect} /> : null;
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

function RailRowAction({ action, session, organizer, actions, tabIndex }: {
  action: ThreadRailRowAction;
  session: UiSession;
  organizer: ThreadRailOrganizer;
  actions: WorkbenchActions;
  tabIndex: number;
}) {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; sections: MenuSection[] }>();
  return <>
    <button type="button" aria-label={action.label} aria-haspopup="menu" aria-expanded={Boolean(menu)} tabIndex={tabIndex}
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
  modelProvider,
  startedAt,
  cursor,
  onSelect,
  organizer,
  actions,
}: {
  organizer?: ThreadRailOrganizer;
  actions: WorkbenchActions;
  id: string;
  active: boolean;
  /** The row the arrow keys are on: the only one Tab stops at. */
  cursor: boolean;
  activity: ThreadActivity;
  activityLabel?: string;
  activityHint?: string;
  activityIcon?: ReactNode;
  compact: boolean;
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
  const age = useRowAge(session?.modifiedAt ?? 0, sessionAge);
  if (!session) return null;
  const diff = diffStat(stat, compact || activity === "settled");
  const marks = accessoryMarks(accessories, session);
  return (
    <ThreadRow
      session={session}
      machine={session.machine ? { name: session.machine.name, icon: <Server size={13} aria-hidden="true" /> } : undefined}
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
      modelProvider={modelProvider}
      startedAt={startedAt}
      tabIndex={cursor ? 0 : -1}
      onSelect={onSelect}
      onToggleSettled={readOnly ? undefined : () => {
        if (organizer) organizer.runMenu(session, activity === "settled" ? "unsettle" : "settle", actions);
        else preferences.toggleSettled(session.id);
      }}
      actions={!readOnly && organizer ? organizer.rowActions?.(session).map((action) =>
        <RailRowAction key={action.id} action={action} session={session} organizer={organizer} actions={actions} tabIndex={cursor ? 0 : -1} />
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
export function railDrafts(drafts: readonly DraftThread[], filter: { project?: RailProjectFilter; projects?: readonly UiProject[]; listed?: ReadonlySet<string> }): DraftThread[] {
  return drafts.filter((draft) =>
    !(draft.sessionId && filter.listed?.has(draft.sessionId)) &&
    projectFilterIncludes(filter.project, draft, filter.projects ?? []));
}

const DraftRailRow = memo(function DraftRailRow({ draft, onOpen }: { draft: DraftThread; onOpen(draftId: string): void }) {
  const store = useThreadStore();
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const icon = useProjectIcon(useMemo(() => findProjectForSession(projects, draft), [draft, projects]));
  const workspace = useWorkspaceStore();
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [checkoutBranch, setCheckoutBranch] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void workspace.host.getWorkspaceInfo(draft.workspaceId ?? draft.projectPath).then((info) => {
      if (!cancelled) setCheckoutBranch(info.branch);
    }).catch(() => { /* A disconnected host leaves the branch unknown. */ });
    return () => { cancelled = true; };
  }, [workspace, draft.workspaceId, draft.projectPath]);
  const branch = draft.active && state.cwd === draft.projectPath
    ? (state.workspaceMode === "worktree" ? state.draftBranch ?? state.draftBase ?? state.workspace?.branch : state.workspace?.branch) ?? checkoutBranch
    : checkoutBranch;
  return <DraftRow draft={draft} {...(icon ? { projectIcon: icon } : {})} {...(branch ? { branch } : {})} onOpen={onOpen} />;
});

/** Subscribes to the drafts on its own, so typing in a draft repaints these rows and nothing else. */
const RailDrafts = memo(function RailDrafts({ actions, project, projects, listed, cursorId, bind }: { actions: WorkbenchActions; project?: RailProjectFilter; projects: readonly UiProject[]; listed: ReadonlySet<string>; cursorId?: string; bind(id: string): (element: HTMLElement | null) => void }) {
  const store = useThreadStore();
  const drafts = useSyncExternalStore(store.subscribeToDrafts, store.getDrafts);
  const shown = useMemo(() => railDrafts(drafts, { project, projects, listed }), [drafts, listed, project, projects]);
  const openContextMenu = useContextMenu();
  const [discarding, setDiscarding] = useState<DraftThread>();
  if (!actions.openDraft || shown.length === 0) return null;
  // Discard is the draft's menu: the row keeps its quiet "draft" on hover, as a thread keeps its state.
  const menu = (event: ReactMouseEvent, draft: DraftThread) => {
    event.stopPropagation();
    void openContextMenu(event, [
      { items: [{ id: "open", label: "Open draft", icon: <SquarePen size={13} /> }] },
      ...(actions.discardDraft ? [{ items: [{ id: "discard", label: "Discard draft", icon: <Trash2 size={13} />, destructive: true }] }] : []),
    ]).then((choice) => {
      if (choice === "open") actions.openDraft?.(draft.draftId);
      // A draft with something in it has no undo, so it asks first.
      if (choice === "discard") { if (draft.preview || draft.attachments) setDiscarding(draft); else actions.discardDraft?.(draft.draftId); }
    });
  };
  return (
    <div className="rail-drafts" role="group" aria-label="Drafts">
      {shown.map((draft) => (
        <div key={draft.draftId} className="rail-row rail-draft" data-navigation-row={`draft:${draft.draftId}`} ref={(element) => {
          bind(`draft:${draft.draftId}`)(element);
          // DraftRow predates the roving tabIndex prop on ThreadRow.
          const button = element?.querySelector<HTMLButtonElement>(".thread-main");
          if (button) button.tabIndex = cursorId === `draft:${draft.draftId}` ? 0 : -1;
        }} onContextMenu={(event) => menu(event, draft)}>
          <DraftRailRow draft={draft} onOpen={actions.openDraft!} />
        </div>
      ))}
      {discarding ? <ConfirmDialog
        title="Discard this draft?"
        message={`“${draftTitle(discarding)}” and its attachments are gone for good.`}
        confirmLabel="Discard draft"
        destructive
        onCancel={() => setDiscarding(undefined)}
        onConfirm={() => { setDiscarding(undefined); actions.discardDraft?.(discarding.draftId); }}
      /> : null}
    </div>
  );
});

/**
 * Another machine's thread among this machine's: the same card, with that
 * machine's mark before the provider marks. It opens there, and is settled there.
 */
const ExternalThreadRow = memo(function ExternalThreadRow({ thread, cursor, onOpen, onLookIn, onToggleSettled }: {
  thread: RailExternalThread;
  /** The row the arrow keys are on: the only one Tab stops at. */
  cursor: boolean;
  onOpen(thread: RailExternalThread): void;
  onLookIn(thread: RailExternalThread): void;
  onToggleSettled?(thread: RailExternalThread): void;
}) {
  const { session, machine, unavailable, opening, running, settled, background } = thread;
  const age = useRowAge(session.modifiedAt, sessionAge);
  const waits = background && !running && !settled;
  const activity: ThreadActivity = opening ? "ready" : unavailable ? "offline" : running ? "working" : waits ? "background" : settled ? "settled" : "idle";
  const label = opening ? "Opening…" : unavailable ? (running ? "Paused · offline" : "Offline") : running ? "Working" : waits ? "Waiting" : undefined;
  const lookIn = thread.lookIn && !unavailable && !opening
    ? <button type="button" aria-label={`Look in on ${session.title} here`} tabIndex={cursor ? 0 : -1} {...tooltipProps("Read it in a tab here; the window stays on this machine")} onClick={() => onLookIn(thread)}><Eye size={13} /></button>
    : undefined;
  return (
    <div className={`rail-external${unavailable ? " unavailable" : ""}`} aria-disabled={unavailable ? true : undefined}>
      <ThreadRow
        session={session}
        machine={machine}
        projectIcon={thread.projectIcon}
        active={false}
        age={age}
        activity={activity}
        {...(label ? { activityLabel: label } : {})}
        {...(unavailable ? { activityHint: unavailable } : waits ? { activityHint: `Work on ${machine.name} wakes it again.` } : {})}
        hoverCard
        tabIndex={cursor ? 0 : -1}
        actions={lookIn}
        {...(onToggleSettled && thread.toggleSettled && !unavailable && !opening ? { onToggleSettled: () => onToggleSettled(thread) } : {})}
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
      projectIcon={thread.projectIcon}
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
  const sorted = threads.slice().sort((left, right) => Number(pins.has(right.id)) - Number(pins.has(left.id)) || railAnchor(right) - railAnchor(left));
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
/** Every mark on the rail is a kit's React node. */
type RailStatus = ThreadRowStatus & { icon?: ReactNode };

/** A settled row shows its age; the label is only the hover card's. */
const SETTLED_STATUS: RailStatus = { activity: "settled", label: "Settled" };

export const WorkspaceSidebar = memo(function WorkspaceSidebar({ actions }: SidebarContributionProps) {
  const { snapshot, registry } = useWorkbenchShell();
  useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const subscribeLineage = useCallback((listener: () => void) => registry.subscribeData("lineage", listener), [registry]);
  const lineage = useSyncExternalStore(subscribeLineage, () => registry.getThreadLineage());
  const threadStore = useThreadStore();
  const workspace = useWorkspaceStore();
  const organizer = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRailOrganizer);
  const railSections = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railSections);
  const railThreadSources = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railThreadSources);
  const ownMarks = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowStatuses);
  const kitMarks = useSyncExternalStore(registry.subscribeMarks, registry.getThreadRowMarks);
  // Marks set through this kit's store predate the core's; both draw alike.
  const rowStatuses = useMemo(() => ({ ...kitMarks, ...ownMarks }), [kitMarks, ownMarks]);
  const dropTargets = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadDropTargets);
  const externalThreads = useRailExternalThreads(railThreadSources);
  const organizerVersion = useSyncExternalStore(organizer?.subscribe ?? noSubscription, organizer?.getVersion ?? noVersion);
  const projectFilter = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().railProjectFilter);
  const projects = useSyncExternalStore(threadStore.subscribeToProjects, threadStore.getProjects);
  const navigationSnapshot = useSyncExternalStore(threadStore.subscribeToIds, threadStore.getSnapshot);
  const ownActivity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const threads = navigationSnapshot.threads;
  const activityState = useMemo(() => railActivity(ownActivity, threads, lineage), [ownActivity, threads, lineage]);
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE_SIZE);
  const clientStorage = useClientStorage();
  const [shelfOpen, setShelfOpen] = useState<ShelvesOpen>(() => readShelvesOpen(clientStorage));
  const [shelfLimits, setShelfLimits] = useState<Readonly<Record<string, number>>>({});
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [groupsOpen, setGroupsOpen] = useState(() => readRailGroupsOpen(clientStorage));
  const [selection, setSelection] = useState<RailSelection>(NO_SELECTION);
  const [fileDrop, setFileDrop] = useState<string>();
  const openContextMenu = useContextMenu();
  // A Read-only device could never send a new thread's first message.
  const { readOnly: readOnlyDevice } = useHostCapabilities();
  const listRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const virtualRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
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
      .filter((session) => projectFilterIncludes(projectFilter, session, projects)),
  // `liveKey` stands for the two sets the filter reads.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  ), [threads, lineage.parents, liveKey, projectFilter, projects]);
  const sections = useMemo(
    () => organizer
      ? organizer.sections(matching, {
        ...activityState,
        waitingThreadIds: [...activityState.waitingThreadIds, ...attentionMarkIds(rowStatuses)],
        // Work that wakes a thread, and runs this host does not see (another machine's, through a kit's mark).
        backgroundThreadIds: matching.filter((session) => ["background", "working"].includes(markedRowStatus(threadRowStatus(session.id, activityState, session), rowStatuses[session.id]).activity)).map((session) => session.id),
      })
      : defaultRailSections(matching, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf),
    // The organizer's version says when the same threads would land elsewhere.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [matching, activityState, rowStatuses, organizer, organizerVersion, settings.pinnedThreadIds, settings.settledThreadIds, showSettledShelf],
  );
  // Other machines' threads join the main list by the same filters and order; the rail's sections stay this machine's.
  const outside = useMemo(() => {
    const byKey = new Map<string, RailExternalThread>();
    for (const thread of externalThreads) {
      const { session } = thread;
      if (session.parentThreadId) continue;
      if (!projectFilterIncludes(projectFilter, session, projects)) continue;
      byKey.set(thread.key, thread);
    }
    return byKey;
  }, [externalThreads, projectFilter, projects]);
  const mainIndex = Math.max(0, sections.findIndex((section) => !section.label));
  const ownMain = sections[mainIndex] ?? { id: "active", threads: [] };
  // A thread settled on its machine goes on the settled shelf, where there is one.
  const shelfIndex = sections.findIndex((section) => section.settled && section.shelf);
  const workingIndex = sections.findIndex((section) => section.id === "working");
  const [outsideActive, outsideSettled, outsideWorking] = useMemo(() => {
    const active: UiSession[] = [];
    const settled: UiSession[] = [];
    const working: UiSession[] = [];
    for (const thread of outside.values()) {
      const target = thread.settled && shelfIndex >= 0 ? settled
        : workingIndex >= 0 && (thread.running || thread.background) && !thread.waiting && !thread.unavailable && !thread.session.turnError && !thread.session.runtimeError && !thread.session.limit && !thread.session.interrupted ? working : active;
      target.push(thread.session);
    }
    return [active, settled, working];
  }, [outside, shelfIndex, workingIndex]);
  const main = useMemo(
    () => outsideActive.length === 0 ? ownMain : { ...ownMain, threads: mergeByTime(ownMain.threads, outsideActive) },
    [outsideActive, ownMain],
  );
  const shownSections = useMemo(
    () => sections.map((section, index) => {
      const extra = index === shelfIndex ? outsideSettled : index === workingIndex ? outsideWorking : [];
      return extra.length ? { ...section, threads: mergeByTime(section.threads, extra) } : section;
    }),
    [outsideSettled, outsideWorking, sections, shelfIndex, workingIndex],
  );
  const workingCount = shownSections.find((section) => section.id === "working")?.threads.length ?? 0;
  const listedIds = useMemo(() => new Set(matching.map((session) => session.id)), [matching]);
  // A draft on screen is the active row; the thread the host holds behind it is not.
  const draftOnScreen = useSyncExternalStore(threadStore.subscribeToDrafts, () => threadStore.getDrafts().some((draft) => draft.active));
  const draftKeys = useSyncExternalStore(threadStore.subscribeToDrafts, () => JSON.stringify(railDrafts(threadStore.getDrafts(), { project: projectFilter, projects, listed: listedIds }).map((draft) => draft.draftId)));
  const draftIds = useMemo(() => JSON.parse(draftKeys) as string[], [draftKeys]);
  const draftCount = draftIds.length;
  const grouped = order.grouping !== "none";
  const visibleActive = grouped ? main.threads : main.threads.slice(0, threadLimit);
  const inSections = (id: string) => sections.flatMap((section) => section.threads).find((session) => session.id === id);
  const { drag, onPointerDown } = useRailDrag(organizer, sections, dropTargets && ((id, target) => {
    const session = inSections(id);
    if (session) dropTargets.drop(session, target, actions);
  }));
  // Read once per drag: what the machines say now.
  const dragged = drag && inSections(drag.threadId);
  const dragTargets = useMemo(
    () => dragged && dropTargets ? dropTargets.targets(dragged, actions) : [],
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [dragged, dropTargets],
  );

  const sectionIsOpen = (section: ThreadRailSection) => section.shelf ? shelfIsOpen(section, shelfOpen) : groupsOpen[`section:${section.id}`] ?? true;
  const mainOpen = sectionIsOpen(main);
  const navigationRows = useMemo(() => mainOpen ? navigationRowsFor(visibleActive, order, projects, openGroups, groupsOpen) : [], [mainOpen, openGroups, groupsOpen, order, projects, visibleActive]);
  const rowVirtualizer = useVirtualizer({
    count: navigationRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => navigationRows[index]?.kind === "thread" ? ROW_STRIDE : navigationRows[index]?.kind === "more" ? 34 : 28,
    getItemKey: (index) => navigationRowKey(navigationRows, index),
    overscan: 6,
    scrollMargin,
  });

  // The same derivation as a tablet's and a phone's list, so every client names a state alike.
  const activityFor = (sessionId: string): RailStatus => {
    return markedRowStatus(threadRowStatus(sessionId, activityState, threadStore.getThread(sessionId)), rowStatuses[sessionId]) as RailStatus;
  };

  const toggleSettled = useCallback((session: UiSession) => {
    if (organizer) organizer.toggleSettled(session);
    else preferences.toggleSettled(session.id);
  }, [organizer, preferences]);


  const openExternal = useCallback((thread: RailExternalThread) => thread.open(actions), [actions]);
  const lookInExternal = useCallback((thread: RailExternalThread) => thread.lookIn?.(actions), [actions]);
  const settleExternal = useMemo(
    () => readOnlyDevice ? undefined : (thread: RailExternalThread) => thread.toggleSettled?.(actions),
    [actions, readOnlyDevice],
  );

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

  const renderRow = (session: UiSession, { activity: status, label, hint, icon, startedAt }: RailStatus, compact = false, cursor = session.id === cursorId) => (
    <ConnectedThreadRow
      key={session.id}
      id={session.id}
      active={!draftOnScreen && session.id === activityState.activeThreadId}
      activity={status}
      activityLabel={label}
      activityHint={hint}
      activityIcon={icon}
      compact={(compact || compactRows) && status !== "settled"}
      modelProvider={!draftOnScreen && session.id === activityState.activeThreadId ? snapshot?.model?.provider : undefined}
      startedAt={startedAt ?? activityState.runningStartedAt[session.id]}
      cursor={cursor}
      onSelect={actions.switchSession}
      organizer={organizer}
      actions={actions}
    />
  );

  const toggleGroup = (id: string, open: boolean) => setGroupsOpen((current) => {
    const next = { ...current, [id]: open };
    clientStorage.set(GROUPS_OPEN_KEY, JSON.stringify(next));
    return next;
  });
  const toggleShelf = (id: string, open: boolean) => setShelfOpen((current) => {
    const next = { ...current, [id]: open };
    writeShelvesOpen(clientStorage, next);
    return next;
  });
  const toggleSection = (section: ThreadRailSection, open: boolean) => section.shelf ? toggleShelf(section.id, open) : toggleGroup(`section:${section.id}`, open);
  const sectionRows = new Map(shownSections.filter((_, index) => index !== mainIndex).map((section) => {
    const open = sectionIsOpen(section);
    const limit = shelfLimits[section.id] ?? (section.shelf ? shelfFirstPage(section) : THREAD_PAGE_SIZE);
    const rows = section.shelf ? rowsOfShelf(section, open, limit, activityState.activeThreadId) : open ? section.threads.slice(0, limit) : [];
    return [section.id, { open, limit, rows, hidden: Math.max(0, section.threads.length - Math.max(limit, rows.length)) }] as const;
  }));
  const sectionNavigation = (section: ThreadRailSection): RailNavigationRow[] => {
    if (!section.threads.length && !drag) return [];
    const { open, rows, hidden } = sectionRows.get(section.id)!;
    const parentId = `section:${section.id}`;
    return [
      { id: parentId, kind: "heading", expanded: open },
      ...rows.map((session): RailNavigationRow => ({ id: session.id, kind: "thread", parentId })),
      ...(open && hidden > 0 ? [{ id: `more:section:${section.id}`, kind: "more" as const, parentId }] : []),
    ];
  };
  const mainHeading = main.threads.length > 0 || Boolean(drag && sections.length > 1);
  const mainHeadingId = `section:${main.id}`;
  let parentId: string | undefined = mainHeading ? mainHeadingId : undefined;
  const cursorRows: RailNavigationRow[] = [
    ...shownSections.slice(0, mainIndex).flatMap(sectionNavigation),
    ...draftIds.map((id): RailNavigationRow => ({ id: `draft:${id}`, kind: "draft" })),
    ...(mainHeading ? [{ id: mainHeadingId, kind: "heading" as const, expanded: mainOpen }] : []),
    ...navigationRows.map((row, virtualIndex): RailNavigationRow => {
      const parent = row.kind === "group" ? (mainHeading ? mainHeadingId : undefined) : parentId;
      if (row.kind === "group") parentId = row.id;
      return { id: row.id, kind: row.kind === "group" ? "heading" : row.kind, parentId: parent, virtualIndex, ...(row.kind === "group" ? { expanded: row.expanded } : {}) };
    }),
    ...(mainOpen && visibleActive.length < main.threads.length ? [{ id: `more:section:${main.id}`, kind: "more" as const, parentId: mainHeadingId }] : []),
    ...shownSections.slice(mainIndex + 1).flatMap(sectionNavigation),
  ];
  const navigation = useRailNavigation(cursorRows, navigationRef, draftOnScreen ? `draft:${threadStore.getDrafts().find((draft) => draft.active)?.draftId}` : activityState.activeThreadId, (row, element) => {
    if (row.virtualIndex !== undefined) rowVirtualizer.scrollToIndex(row.virtualIndex, { align: "auto" });
    else element?.scrollIntoView?.({ block: "nearest" });
  });
  const { cursorId } = navigation;
  const navigationData = (id: string) => ({ "data-navigation-row": id, ref: navigation.bind(id), ...(id === cursorId ? { "data-cursor": "" } : {}) });

  // Shelves, drafts and the Active heading precede the virtual list in the same scroller.
  // TanStack must include their measured height when locating a model row.
  useLayoutEffect(() => {
    const scroller = listRef.current;
    const virtual = virtualRef.current;
    if (!scroller || !virtual) return;
    const measure = () => setScrollMargin(virtual.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const element of virtual.parentElement?.children ?? []) if (element !== virtual) observer.observe(element);
    return () => observer.disconnect();
  });

  // Rows travel when a thread changes place; a drag moves them by hand.
  const motionPlaces = new Map<string, RailPlace>();
  for (const section of shownSections) {
    const place = { section: section.id, shelf: Boolean(section.shelf), folded: !sectionIsOpen(section) };
    for (const session of section.threads) motionPlaces.set(session.id, place);
  }
  for (const session of main.threads) motionPlaces.set(session.id, { section: main.id, shelf: false, folded: !mainOpen });
  const motionKey = [
    draftCount,
    navigationRows.map((row) => row.id).join(","),
    ...shownSections.map((section) => `${section.id}:${sectionIsOpen(section)}:${section.threads.map((session) => session.id).join(",")}`),
  ].join("|");
  const rowsRef = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createRailMotion>>(undefined);
  const motionKeyDrawn = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!rowsRef.current) return;
    const created = createRailMotion(rowsRef.current);
    motion.current = created;
    return () => { created.dispose(); motion.current = undefined; motionKeyDrawn.current = undefined; };
  }, []);
  useLayoutEffect(() => {
    if (motionKeyDrawn.current === motionKey) motion.current?.refresh(motionPlaces);
    else motion.current?.update(motionPlaces, !drag);
    motionKeyDrawn.current = motionKey;
  });

  /** Shift-click spans only threads; the keyboard cursor also visits headings, drafts and More. */
  const orderIds = cursorRows.filter((row) => row.kind === "thread").map((row) => row.id);
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
    ...navigationData(id),
  });
  // No `data-rail-thread`: drags, drops, menus and picks leave these rows alone.
  const externalData = (key: string) => ({ "data-rail-external": key, ...navigationData(key) });

  const renderSection = (section: ThreadRailSection): ReactNode => {
    // An empty section shows its heading only while a thread could be dropped on it.
    if (section.threads.length === 0 && !drag) return null;
    const { open, rows, limit, hidden } = sectionRows.get(section.id)!;
    const heading = section.shelf ? shelfHeading(section) : `${section.label} · ${section.threads.length}`;
    const target = drag?.drop?.sectionId === section.id ? " drop-target" : "";
    return (
      <section key={section.id} className={`${section.shelf ? "settled-shelf" : "rail-section"} rail-section-${section.id}`}>
        <button
          type="button"
          className={`${section.shelf ? "settled-shelf-toggle" : "thread-group-label"}${target}`}
          data-rail-heading={section.id}
          {...navigationData(`section:${section.id}`)}
          tabIndex={cursorId === `section:${section.id}` ? 0 : -1}
          aria-expanded={open}
          onClick={() => toggleSection(section, !open)}
        >
          <span>{heading}</span><i aria-hidden="true" />
          <b><ChevronDown size={12} aria-hidden="true" /></b>
        </button>
        {rows.map((session, index) => {
          const external = outside.get(session.id);
          if (external) {
            return (
              <div key={session.id} className={rowClass(section.id, session.id, index === rows.length - 1)} {...externalData(session.id)}>
                <ExternalThreadRow thread={external} cursor={external.key === cursorId} onOpen={openExternal} onLookIn={lookInExternal} {...(settleExternal ? { onToggleSettled: settleExternal } : {})} />
              </div>
            );
          }
          const status = section.settled ? SETTLED_STATUS : activityFor(session.id);
          return (
            <div key={session.id} className={rowClass(section.id, session.id, index === rows.length - 1)} {...rowData(section.id, session.id)}>
              {/* Working threads keep the full card; only parked shelves fold to one line. */}
              {renderRow(session, status, Boolean(section.shelf) && section.id !== "working")}
            </div>
          );
        })}
        {open && hidden > 0 ? (
          <div {...navigationData(`more:section:${section.id}`)}><ShowMoreThreadRow
            cursor={cursorId === `more:section:${section.id}`}
            remaining={hidden}
            onClick={() => setShelfLimits((current) => ({ ...current, [section.id]: Math.min(section.threads.length, limit + SHELF_PAGE) }))}
          /></div>
        ) : null}
      </section>
    );
  };

  const findSession = inSections;
  const clearSelection = () => setSelection((current) => current.ids.size ? { ids: new Set(), ...(current.anchor ? { anchor: current.anchor } : {}) } : current);

  const openMenu = (event: ReactMouseEvent) => {
    const id = rowIdOf(event.target) ?? (event.target === event.currentTarget ? cursorId : undefined);
    // Without an organizer the menu only settles.
    if (!organizer) {
      const session = id ? findSession(id) : undefined;
      if (!session) return;
      const settled = settings.settledThreadIds.includes(session.id);
      void openContextMenu(event, projectPromotionMenu([{ items: [{ id: "settle", label: settled ? "Un-settle thread" : "Settle thread", disabled: readOnlyDevice, icon: settled ? <ArchiveRestore size={13} /> : <Check size={13} /> }] }], session, readOnlyDevice)).then((choice) => {
        if (choice === PROMOTE_PROJECT) workspace.openProjectPromotion(session);
        else if (choice) toggleSettled(session);
      });
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
        <div className="rail-head">
          {/* On macOS it sits at the title bar's right edge, above the new-thread button. */}
          {actions.toggleSidebar ? <button
            type="button"
            className="sidebar-action sidebar-toggle"
            aria-label="Hide sidebar"
            {...tooltipProps("Hide sidebar", { side: "bottom", shortcut: registry.keybindingLabel("workbench.toggle-sidebar") })}
            onClick={actions.toggleSidebar}
          >
            <PanelLeft size={16} />
          </button> : null}
          <RailProjectControls actions={actions} counts={() => {
            const counts = new Map<string, number>([["all", 0]]);
            for (const session of visibleThreads(threadStore.getSnapshot().threads, registry.getThreadLineage().parents)) {
              counts.set("all", (counts.get("all") ?? 0) + 1);
              const project = session.projectless ? undefined : findProjectForSession(projects, session);
              const id = session.projectless ? NO_PROJECT : session.workspaceId ?? (project ? projectId(project) : undefined);
              if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
            }
            return counts;
          }}>
            <button type="button" className="sidebar-action rail-search" aria-label="Search"
              {...tooltipProps("Search", { side: "bottom", ...(paletteKeys ? { shortcut: paletteKeys } : {}) })}
              onClick={() => actions.openCommandPalette()}><Search size={15} /></button>
          </RailProjectControls>
        </div>
        <ProjectSwitcher actions={actions} />
      </div>

      <nav
        ref={navigationRef}
        className={`session-list${drag ? " rail-dragging" : ""}`}
        aria-label="Threads"
        aria-busy={organizer?.isLoading?.() === true}
        // A proxy stop while the model cursor's virtual row has not mounted.
        tabIndex={navigation.cursorMounted ? -1 : 0}
        onPointerDown={onPointerDown}
        onFocus={navigation.onFocus}
        onBlur={navigation.onBlur}
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
          const target = event.target as Element;
          // The renderer owns F2/context menu/mod+Enter. This handler alone owns the model cursor.
          if (event.defaultPrevented || event.nativeEvent.isComposing || registry.getProfile() === "compact" || document.body.dataset.profile === "compact" || !event.currentTarget.contains(target) || target.closest('.thread-row-actions, .thread-group-new, input, textarea, select, [contenteditable], [data-keybinding-capture]')) return;
          if (event.key === "Escape" && selection.ids.size) { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          const currentId = railNavigationId(target) ?? cursorId;
          const current = cursorRows.find((row) => row.id === currentId);
          if (!current) return;
          if (["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            if (current.kind === "heading" && ((event.key === "ArrowLeft" && current.expanded) || (event.key === "ArrowRight" && !current.expanded))) {
              const section = [main, ...shownSections].find((entry) => `section:${entry.id}` === current.id);
              if (section) toggleSection(section, !current.expanded);
              else toggleGroup(current.id, !current.expanded);
              return;
            }
            const nextId = railKeyDestination(cursorRows, currentId, event.key);
            if (!nextId) return;
            navigation.focus(nextId);
            if (!["ArrowUp", "ArrowDown"].includes(event.key) || !ownIds.includes(nextId)) return;
            if (event.shiftKey) setSelection((selectionNow) => selectRange(selectionNow.anchor ? selectionNow : { ...selectionNow, anchor: currentId }, nextId, ownIds));
            else setSelection((selectionNow) => selectionNow.ids.size ? selectionNow : { ids: selectionNow.ids, anchor: nextId });
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); event.stopPropagation();
            if (target === event.currentTarget) navigation.focus(current.id, true);
            else target.closest<HTMLElement>("button")?.click();
          }
        }}
      >
        {/* One scroll; the shelves consume the free space above them on short lists. */}
        {organizer?.isLoading?.() ? <p className="sidebar-empty" role="status">Loading threads…</p> : null}
        <div ref={listRef} className="rail-active" style={organizer?.isLoading?.() ? { visibility: "hidden" } : undefined} inert={organizer?.isLoading?.() === true}>
        <div ref={rowsRef} className="rail-active-rows">
        {shownSections.slice(0, mainIndex).map(renderSection)}
        <RailDrafts actions={actions} project={projectFilter} projects={projects} listed={listedIds} cursorId={cursorId} bind={navigation.bind} />
        {mainHeading ? <button
          type="button"
          className={`thread-group-label rail-main-label${drag?.drop?.sectionId === main.id ? " drop-target" : ""}`}
          data-rail-heading={main.id}
          {...navigationData(mainHeadingId)}
          tabIndex={cursorId === mainHeadingId ? 0 : -1}
          aria-expanded={mainOpen}
          onClick={() => toggleSection(main, !mainOpen)}
        ><span>{main.label ?? "Active"} · {main.threads.length}</span><i /><b><ChevronDown size={12} aria-hidden="true" /></b></button> : null}
        <div ref={virtualRef} className="rail-virtual" style={{ height: rowVirtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}>
          {rowVirtualizer.getVirtualItems().map((item) => {
            const row = navigationRows[item.index];
            if (!row) return null;
            const threadRow = row.kind === "thread";
            return (
              <div
                key={row.id}
                data-index={item.index}
                className={threadRow ? rowClass(main.id, row.id, item.index === navigationRows.length - 1) : undefined}
                {...(threadRow ? (outside.has(row.id) ? externalData(row.id) : rowData(main.id, row.id)) : navigationData(row.id))}
                ref={(element) => { rowVirtualizer.measureElement(element); navigation.bind(row.id)(element); }}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - scrollMargin}px)` }}
              >
                {row.kind === "group" ? (
                  <div className="thread-group-label rail-project-heading">
                    <button type="button" className="thread-group-toggle" data-navigation-target data-rail-group={row.id}
                      tabIndex={cursorId === row.id ? 0 : -1} aria-expanded={row.expanded}
                      onClick={() => toggleGroup(row.id, !row.expanded)}>
                      <span>{row.label} · {row.count}</span><i /><b><ChevronDown size={12} aria-hidden="true" /></b>
                    </button>
                    {/* The project header's "+": a new thread in this project, whatever is on screen. */}
                    {row.project && !readOnlyDevice ? <button
                      type="button"
                      className="thread-group-new"
                      tabIndex={cursorId === row.id ? 0 : -1}
                      aria-label={`New thread in ${row.project.name}`}
                      {...tooltipProps(`New thread in ${row.project.name}`, { side: "top" })}
                      onClick={() => actions.newSession({ workspace: row.project!.workspaceId ?? row.project!.path })}
                    ><SquarePen size={13} /></button> : null}
                  </div>
                ) : row.kind === "more" ? (
                  <ShowMoreThreadRow cursor={cursorId === row.id} remaining={row.remaining} all onClick={() => setOpenGroups((current) => new Set([...current, row.key]))} />
                ) : (() => {
                  const external = outside.get(row.id);
                  if (external) return <ExternalThreadRow thread={external} cursor={external.key === cursorId} onOpen={openExternal} onLookIn={lookInExternal} {...(settleExternal ? { onToggleSettled: settleExternal } : {})} />;
                  const status = activityFor(row.session.id);
                  return renderRow(row.session, status);
                })()}
              </div>
            );
          })}
        </div>

        {mainOpen && visibleActive.length < main.threads.length ? (
          <div {...navigationData(`more:section:${main.id}`)}><ShowMoreThreadRow
            cursor={cursorId === `more:section:${main.id}`}
            remaining={main.threads.length - visibleActive.length}
            onClick={() => setThreadLimit((limit) => Math.min(main.threads.length, limit + THREAD_PAGE_SIZE))}
          /></div>
        ) : null}

        {matching.length === 0 && outside.size === 0 && draftCount === 0 ? (
          projectFilter
            ? <p className="sidebar-empty">{`No threads in ${projectFilterLabel(projectFilter, workspace.getSnapshot().railProjectGroups, projects)}`}</p>
            : <div className="sidebar-empty first"><i><MessageSquare size={16} aria-hidden /></i><p>No threads yet.<br />They’ll line up here.</p></div>
        ) : null}

        {draftCount === 0 && main.threads.length === 0 && shownSections.slice(0, mainIndex).every((section) => section.threads.length === 0) && shownSections.slice(mainIndex + 1).some((section) => section.threads.length > 0) ? (
          <div className="sidebar-empty active"><i><CircleCheck size={16} aria-hidden /></i>{workingCount
            ? <p>Nothing needs you yet<small>{workingCount} working</small></p>
            : <p>All caught up</p>}</div>
        ) : null}

        {(() => {
          const shelves = shownSections.slice(mainIndex + 1).map(renderSection).filter(Boolean);
          return shelves.length ? <div className="rail-shelves">{shelves}</div> : null;
        })()}
        </div>
        </div>
      </nav>

      {drag ? null : <ThreadCardLayer root={listRef} render={renderCard} />}
      {drag && dragged ? (() => {
        const status = activityFor(dragged.id);
        // Over a machine the card rises above the pointer, so the row it would land on stays readable.
        return <div className="rail-drag-card" aria-hidden style={{ left: drag.x - drag.grab.x, top: drag.y - (drag.target ? 90 : drag.grab.y), width: drag.grab.width }}>
          {renderRow(dragged, status, false, false)}
        </div>;
      })() : null}
      {drag?.label ? <div className="rail-drag-label" style={{ left: drag.x + 14, top: drag.y + 10 }}>{drag.label}</div> : null}
      {dragTargets.length && dropTargets ? <div className="rail-drop-panel" role="group" aria-label={dropTargets.heading}>
        <div className="rail-drop-heading">{dropTargets.heading}</div>
        {dragTargets.map((target) => (
          <div
            key={target.id}
            className={`rail-drop-target${target.disabled ? " disabled" : ""}${drag?.target === target.id ? " over" : ""}`}
            {...(target.disabled ? {} : { "data-rail-drop": target.id })}
          >
            {target.icon}
            <div><b>{target.label}</b>{target.detail ? <small>{target.detail}</small> : null}</div>
            {drag?.target === target.id ? <Check size={14} /> : null}
          </div>
        ))}
      </div> : null}
      {organizer?.Layer ? <organizer.Layer actions={actions} /> : null}
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
