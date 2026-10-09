import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronDown, GitBranch, Mail, MailOpen, MessageCircleQuestion, Pin, PinOff, RotateCcw, Server, Square, SquarePen, Trash2, TriangleAlert } from "lucide-react";
import { errorMessage } from "../../workbench/error-message";
import {
  THREAD_LIST_PAGE,
  THREAD_SUPERVISION_LABELS,
  threadAge,
  threadListDrafts,
  threadListGroups,
  type ThreadListGroup,
  type ThreadSupervisionRow,
} from "../../workbench/thread-supervision";
import type { UiProject } from "../../shared/contracts";
import { findProjectForSession } from "../../shared/session-project";
import type { DraftThread } from "../../workbench/draft-threads";
import { DraftRow, draftTitle } from "../components/DraftRow";
import type { ExtensionRegistry, ThreadListEntry, ThreadListPlace, WorkbenchActions } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { showsThreadStatus, ThreadStatus } from "../components/ThreadRow";
import { ProjectIcon } from "../components/ProjectIcon";
import { MiddleTruncate } from "../components/ui/MiddleTruncate";
import { threadCostLabel } from "../cost-format";
import { DEFAULT_RUNTIME, threadOnPlan } from "../runtime-marks";
import { useClientStorage } from "../client-storage-context";
import { useHostClient } from "../host-client-context";
import { commandRefusal, useHostCapabilities, useHostName } from "../use-host-capabilities";
import { usePreferences } from "../renderer-services-context";
import { useThreadStore } from "../workbench-context";
import { ActionSheet, type SheetAction } from "./ActionSheet";
import { SwipeRow, type SwipeAction } from "./SwipeRow";
import { useThreadListSources } from "./thread-list-sources";

/** Finished threads keep a Done badge until settled, regardless of whether they have been read. */
function RowTime({ row }: { row: ThreadSupervisionRow }) {
  const state = row.state.activity === "idle" || row.state.activity === "ready"
    ? { ...row.state, activity: "ready" as const, label: "Done" }
    : row.state;
  if (!row.settled && showsThreadStatus(state.activity)) {
    return <ThreadStatus key={state.activity} activity={state.activity} label={state.label} {...(state.hint ? { hint: state.hint } : {})} icon={state.icon as ReactNode} startedAt={state.startedAt ?? row.modifiedAt} />;
  }
  return <time dateTime={new Date(row.modifiedAt).toISOString()}>{threadAge(row.modifiedAt, Date.now())}</time>;
}

/** Whether this client has the settled shelf open; open is the default, the design's. */
export const SETTLED_OPEN_KEY = "tau.thread-list.settled-open.v1";

/** The branch every checkout starts on says nothing on a row, as on the desktop rail. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

export interface TouchThreadListProps {
  registry: ExtensionRegistry;
  actions: WorkbenchActions;
  onOpen(row: ThreadSupervisionRow): void;
  onStop(row: ThreadSupervisionRow): void;
  /** The next step the empty list offers; absent, the empty list only says so. */
  onNewThread?(): void;
  /** Only this project's threads. */
  project?: UiProject | undefined;
}

/**
 * The compact thread list: pinned, active and settled threads, each row a
 * tap to open and a swipe to settle. A long
 * press (or a right click) lists every action, the kits' `thread-row`
 * commands among them, Stop the run too. A row carries no stop button of its
 * own, as in the design: a run stopped by a slipped tap is lost
 * work, and the open thread's composer stops it in one tap.
 */
export function TouchThreadList({ registry, actions, onOpen, onStop, onNewThread, project }: TouchThreadListProps) {
  const store = useThreadStore();
  const preferences = usePreferences();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const current = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const { pinnedThreadIds, settledThreadIds, showCosts } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [shown, setShown] = useState(THREAD_LIST_PAGE);
  const [openRow, setOpenRow] = useState<string>();
  const [sheetFor, setSheetFor] = useState<ThreadSupervisionRow>();
  const [draftSheet, setDraftSheet] = useState<DraftThread>();
  const allDrafts = useSyncExternalStore(store.subscribeToDrafts, store.getDrafts);
  const drafts = useMemo(
    () => actions.openDraft ? threadListDrafts(allDrafts, snapshot.threads, current, project) : [],
    [actions.openDraft, allDrafts, current, project, snapshot.threads],
  );
  const clientStorage = useClientStorage();
  const [settledOpen, setSettledOpen] = useState(() => clientStorage.get(SETTLED_OPEN_KEY) !== "false");
  const toggleSettled = () => setSettledOpen((open) => {
    clientStorage.set(SETTLED_OPEN_KEY, String(!open));
    return !open;
  });
  const outside = useThreadListSources(registry);
  // Another machine's projects are other projects; the filter keeps those of the same name.
  const extra = useMemo(() => project ? outside.rows.filter((row) => row.projectName === project.name) : outside.rows, [outside.rows, project]);
  const marks = useSyncExternalStore(registry.subscribe, registry.getThreadRowMarks);
  const groups = useMemo(
    () => threadListGroups(snapshot.threads, current, { pinned: pinnedThreadIds, settled: settledThreadIds, shown, extra, marks, ...(project ? { project } : {}) }),
    [current, extra, marks, pinnedThreadIds, project, settledThreadIds, shown, snapshot.threads],
  );
  const rowCommands = registry.getCommandsFor("thread-row");
  const runCommand = (id: string, threadId: string) => {
    const command = rowCommands.find((entry) => entry.id === id);
    if (command) void Promise.resolve(command.run(actions, { threadId })).catch((error: unknown) => actions.notify(errorMessage(error)));
  };

  const settleAction = (row: ThreadSupervisionRow): SwipeAction => row.settled
    ? { id: "unsettle", label: "Un-settle", Icon: RotateCcw, tone: "primary", run: () => preferences.toggleSettled(row.id) }
    : { id: "settle", label: "Settle", Icon: Check, tone: "primary", run: () => preferences.toggleSettled(row.id) };
  // The tray holds settle and the first kit action that brings a glyph (Thread Rail's Snooze).
  const { readOnly } = useHostCapabilities();
  // The host refuses a Read-only device's changes (ADR 0024); the sheet says so rather than offering them.
  const refused = (command: { access?: "read" | "write" }) => commandRefusal(command, readOnly);
  const trayCommand = rowCommands.find((command) => command.Icon && !command.destructive && !refused(command));
  const swipeActions = (row: ThreadSupervisionRow): SwipeAction[] => {
    // Settling is the rail's, which the host keeps: a Read-only device has nothing to swipe to.
    const tray: SwipeAction[] = readOnly ? [] : [settleAction(row)];
    if (trayCommand?.Icon && !row.settled) tray.push({ id: trayCommand.id, label: shortLabel(trayCommand.label), Icon: trayCommand.Icon, tone: "secondary", run: () => runCommand(trayCommand.id, row.id) });
    return tray;
  };
  // The thread's own work first (design 1x): its question, then the panels that offer themselves, each opened over it.
  const panels = registry.getPanels().filter((panel) => panel.threadActions);
  const sheetActions = (row: ThreadSupervisionRow): SheetAction[] => [
    ...(row.status === "waiting" ? [{ id: "answer", label: "Answer the question", Icon: MessageCircleQuestion, run: () => onOpen(row) }] : []),
    ...panels.map((panel): SheetAction => ({ id: `panel:${panel.id}`, label: panel.label, Icon: panel.Icon, run: () => { void actions.switchSession(row.path).then((opened) => { if (opened) actions.openPanel(panel.id); }); } })),
    ...(row.status === "running" ? [{ id: "stop", label: "Stop the run", Icon: Square, disabledReason: refused({}), run: () => onStop(row) }] : []),
    { ...settleAction(row), label: row.settled ? "Un-settle" : "Settle", disabledReason: refused({}) },
    { id: "pin", label: row.pinned ? "Unpin" : "Pin", Icon: row.pinned ? PinOff : Pin, disabledReason: refused({}), run: () => preferences.togglePinned(row.id) },
    row.unread
      ? { id: "read", label: "Mark as read", Icon: MailOpen, run: () => store.markRead(row.id) }
      : { id: "unread", label: "Mark as unread", Icon: Mail, run: () => store.markUnread(row.id) },
    ...rowCommands.map((command): SheetAction => ({
      id: command.id,
      label: command.label,
      Icon: command.Icon,
      destructive: command.destructive,
      disabledReason: refused(command),
      run: () => runCommand(command.id, row.id),
    })),
  ];

  const link = useConnectionState();
  const hostName = useHostName();
  const connection = link.state === "connected" ? null
    : link.state === "reconnecting" && groups.length > 0 ? <Unreachable name={hostName} retry={link.retry} />
      : <ConnectionNotice state={link.state} refusal={link.refusal} empty={groups.length === 0} />;
  if (groups.length === 0 && drafts.length === 0) {
    return <>
      {connection}
      {connection ? null : <div className="touch-thread-empty">
        <strong>{project ? `No threads in ${project.name}` : "No threads yet"}</strong>
        <span>{project ? "Start one here, or show all projects." : "Start a thread to work in one of your projects."}</span>
        {onNewThread && !readOnly ? <button type="button" onClick={onNewThread}>New thread</button> : null}
      </div>}
    </>;
  }
  const rowProps = {
    // A draft on screen is the active row; the thread the host holds behind it is not.
    activeId: allDrafts.some((draft) => draft.active) ? "" : current.activeThreadId,
    openRow,
    setOpenRow,
    swipeActions,
    onOpen,
    onSheet: setSheetFor,
    outside: outside.byKey,
    here: outside.rows.length > 0 ? outside.here : undefined,
    actions,
  };
  const more = (group: ThreadListGroup) => () => setShown((value) => group.id === "settled"
    ? { ...value, settled: value.settled + 25 }
    : { ...value, active: value.active + THREAD_LIST_PAGE.active });
  const settled = groups.find((group) => group.id === "settled");
  const pinned = groups.find((group) => group.id === "pinned");
  const draftSheetActions = (draft: DraftThread): SheetAction[] => [
    { id: "open", label: "Open draft", Icon: SquarePen, run: () => actions.openDraft?.(draft.draftId) },
    ...(actions.discardDraft ? [{ id: "discard", label: "Discard draft", Icon: Trash2, destructive: true, run: () => actions.discardDraft?.(draft.draftId) }] : []),
  ];
  const settledCount = settled ? settled.rows.length + settled.hidden : 0;
  // One scroll, as the desktop rail: the settled shelf follows right after the active threads.
  return <>
    {connection}
    <div className="touch-thread-lists" onScrollCapture={() => setOpenRow(undefined)}>
      <div className="touch-thread-active">
        <ul className="touch-thread-list" aria-label="Threads">
          {pinned ? <GroupRows group={pinned} {...rowProps} onMore={more(pinned)} /> : null}
          {drafts.map((draft) => <DraftListRow key={draft.draftId} draft={draft} onOpen={(id) => actions.openDraft?.(id)} onSheet={setDraftSheet} />)}
          {groups.filter((group) => group !== settled && group !== pinned).map((group) => <GroupRows key={group.id} group={group} {...rowProps} onMore={more(group)} />)}
        </ul>
        {settled ? <div className="touch-thread-shelf">
          <button type="button" className="touch-thread-shelf-toggle" aria-expanded={settledOpen} onClick={toggleSettled}>
            <span>{`Settled · ${settledCount}`}</span><ChevronDown size={14} aria-hidden />
          </button>
          {settledOpen ? <ul className="touch-thread-list" aria-label="Settled threads">
            <GroupRows group={{ ...settled, label: "" }} {...rowProps} onMore={more(settled)} />
          </ul> : null}
        </div> : null}
      </div>
    </div>
    {sheetFor ? <ActionSheet
      title={sheetFor.title}
      head={<div className="touch-thread-row action-sheet-head"><div className="thread-row"><ThreadCard row={sheetFor} onOpen={() => { setSheetFor(undefined); onOpen(sheetFor); }} /></div></div>}
      summary={sheetCost(sheetFor, showCosts)}
      actions={sheetActions(sheetFor)}
      onClose={() => setSheetFor(undefined)}
    /> : null}
    {draftSheet ? <ActionSheet title={draftTitle(draftSheet)} actions={draftSheetActions(draftSheet)} onClose={() => setDraftSheet(undefined)} /> : null}
  </>;
}

const CONNECTION_TEXT: Record<"reconnecting" | "resyncing" | "refused", { title: string; detail: string }> = {
  reconnecting: { title: "Connecting to the host…", detail: "Threads appear once it answers." },
  resyncing: { title: "Updating", detail: "Refetching the threads from the host…" },
  refused: { title: "The host refused this device", detail: "Pair it again from the host's Settings → Connections." },
};

function useConnectionState() {
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined), [client]);
  const state = useSyncExternalStore(subscribe, () => client?.getConnectionState() ?? "connected");
  return { state, refusal: state === "refused" ? client?.getConnectionRefusal() : undefined, retry: () => client?.reconnectNow() };
}

/** "MacBook Pro not reachable · last seen 12 min ago · Retry" over what the list last showed (design 2p). */
function Unreachable({ name, retry }: { name: string | undefined; retry(): void }) {
  const [since] = useState(Date.now);
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.floor((now - since) / 60_000);
  return <p className="touch-thread-notice unreachable" role="status">
    <TriangleAlert size={16} aria-hidden />
    <span>{name ?? "The host"} not reachable · last seen {minutes < 1 ? "just now" : `${minutes} min ago`}</span>
    <button type="button" onClick={retry}>Retry</button>
  </p>;
}

/** A list that may be stale says so; one that never loaded says it is waiting for the host. */
function ConnectionNotice({ state, refusal, empty }: { state: keyof typeof CONNECTION_TEXT; refusal?: string | undefined; empty: boolean }) {
  const text = CONNECTION_TEXT[empty && state !== "refused" ? "reconnecting" : state];
  return <p className={`touch-thread-notice ${state}`} role={state === "refused" ? "alert" : "status"}>
    <strong>{text.title}</strong>
    <span>{refusal || text.detail}</span>
  </p>;
}

/** "Snooze thread…" becomes "Snooze" under a swipe glyph. */
function shortLabel(label: string): string {
  return label.replace(/…$/u, "").replace(/\s+thread$/iu, "");
}

function GroupRows({ group, activeId, openRow, setOpenRow, swipeActions, onOpen, onSheet, onMore, outside, here, actions }: {
  group: ThreadListGroup;
  activeId: string;
  openRow?: string | undefined;
  setOpenRow(id: string | undefined): void;
  swipeActions(row: ThreadSupervisionRow): SwipeAction[];
  onOpen(row: ThreadSupervisionRow): void;
  onSheet(row: ThreadSupervisionRow): void;
  onMore(): void;
  outside: ReadonlyMap<string, ThreadListEntry>;
  here: ThreadListPlace | undefined;
  actions: WorkbenchActions;
}) {
  return <>
    {group.label ? <li role="none" className="touch-thread-group"><span>{group.label}</span></li> : null}
    {group.rows.map((row) => {
      const entry = outside.get(row.id);
      // Another machine's thread only opens there: no swipe, no actions here.
      if (entry) {
        return <li key={row.id} className="touch-thread-row touch-outside-row" data-status={row.status} data-settled={row.settled || undefined} data-unavailable={entry.unavailable ? "" : undefined}>
          <div className={`thread-row${row.settled ? " compact activity-settled" : ""}`}>
            <ThreadCard row={row} projectIcon={entry.projectIcon} machine={entry.machine} unavailable={entry.unavailable} busy={entry.opening} onOpen={() => entry.open(actions)} />
          </div>
        </li>;
      }
      const active = row.id === activeId;
      return <li key={row.id} className="touch-thread-row" data-status={row.status} data-active={active || undefined} data-settled={row.settled || undefined}>
        <SwipeRow
          actions={swipeActions(row)}
          open={openRow === row.id}
          onOpenChange={(open) => setOpenRow(open ? row.id : undefined)}
          onLongPress={() => { setOpenRow(undefined); onSheet(row); }}
        >
          <div className={`thread-row${row.settled ? " compact activity-settled" : ""}${active ? " active" : ""}`}>
            <ThreadCard row={row} machine={here} onOpen={() => onOpen(row)} />
            <button type="button" className="touch-thread-more" aria-label={`Actions for ${row.title}`} onClick={() => onSheet(row)}>…</button>
          </div>
        </SwipeRow>
      </li>;
    })}
    {group.hidden > 0 ? <li role="none" className="touch-thread-more-rows">
      <button type="button" onClick={onMore}>Show {group.hidden} more</button>
    </li> : null}
  </>;
}

/**
 * A new thread's draft above the active threads. No swipe: a draft is never
 * thrown away by a gesture; a long press or its More button offers Discard.
 */
function DraftListRow({ draft, onOpen, onSheet }: { draft: DraftThread; onOpen(draftId: string): void; onSheet(draft: DraftThread): void }) {
  return <li className="touch-thread-row touch-draft-row" data-active={draft.active || undefined}>
    <SwipeRow actions={[]} open={false} onOpenChange={() => undefined} onLongPress={() => onSheet(draft)}>
      <DraftRow
        draft={draft}
        onOpen={onOpen}
        actions={<button type="button" className="touch-thread-more" aria-label={`Actions for draft ${draftTitle(draft)}`} onClick={() => onSheet(draft)}>…</button>}
      />
    </SwipeRow>
  </li>;
}

/** The cost, which the row leaves to the rail's hover card; a phone has no hover, so its sheet says it. */
function sheetCost(row: ThreadSupervisionRow, showCosts: boolean): string | undefined {
  const cost = showCosts ? threadCostLabel(row.usage) : undefined;
  return cost ? `Cost ${cost}` : undefined;
}

/**
 * A thread as the desktop rail's card draws it: the project line with the
 * state or age, the title, and the branch and runtime; a settled one
 * as the rail's slim row.
 */
function ThreadCard({ row, projectIcon, machine, unavailable, busy, onOpen }: {
  row: ThreadSupervisionRow;
  projectIcon?: string | undefined;
  /** Where the thread runs, named while the list shows several machines. */
  machine?: ThreadListPlace | undefined;
  unavailable?: string | undefined;
  busy?: boolean | undefined;
  onOpen(): void;
}) {
  const store = useThreadStore();
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  if (row.machine) machine = { name: row.machine.name, icon: <Server size={13} aria-hidden="true" /> };
  const place = { path: row.projectPath ?? row.projectName, workspaceId: row.workspaceId };
  const project = findProjectForSession(projects, { projectPath: place.path, workspaceId: place.workspaceId, projectName: row.projectName });
  const mark = <ProjectIcon project={{ ...place, ...project, name: row.projectName }} icon={projectIcon} hue={place.path} />;
  const where = machine ? ` on ${machine.name}` : "";
  const label = {
    "aria-label": `Open thread ${row.title}${where}`,
    "aria-description": unavailable ?? THREAD_SUPERVISION_LABELS[row.status],
    ...(busy ? { "aria-busy": true } : {}),
  };
  if (row.settled) {
    return <button type="button" className="thread-main touch-thread-open" {...label} onClick={onOpen}>
      {mark}
      <span className="thread-title">{row.title}</span>
      <RowTime row={row} />
    </button>;
  }
  const branch = row.projectLabel && !DEFAULT_BRANCHES.has(row.projectLabel) ? row.projectLabel : undefined;
  const marks = <span className="thread-meta-end">
    <ProviderIconStack modelProvider={row.modelProvider} runtimeProvider={row.backendKind ?? DEFAULT_RUNTIME} plan={threadOnPlan(row.usage)} className="touch-thread-provider" hint={{ side: "left" }} />
  </span>;
  const title = <span className="thread-title">{row.title}</span>;
  // Without a branch or a pin the marks ride on the title's line: no empty third line.
  const bare = !branch && !row.pinned;
  return <button type="button" className="thread-main touch-thread-open" {...label} onClick={onOpen}>
    <span className="thread-project-line">
      {mark}
      <strong>{row.projectName}</strong>
      {machine ? <span className="touch-thread-machine">{machine.icon}<span>{machine.name}</span></span> : null}
      <RowTime row={row} />
    </span>
    {bare ? <span className="touch-title-line">{title}{marks}</span> : title}
    {/* Right to left, as the rail's card: the branch yields first, the runtime mark last. */}
    {bare ? null : <span className="thread-meta-line">
      {marks}
      {row.pinned ? <span className="thread-meta-marks"><Pin size={12} className="touch-thread-pin" aria-label="Pinned" /></span> : null}
      {branch ? <span className="thread-branch"><GitBranch size={12} aria-hidden="true" /><MiddleTruncate value={branch} /></span> : null}
    </span>}
  </button>;
}
