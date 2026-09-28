import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Check, ChevronDown, Mail, MailOpen, Pin, PinOff, RotateCcw, Square, SquarePen, Trash2 } from "lucide-react";
import {
  THREAD_LIST_PAGE,
  THREAD_SUPERVISION_LABELS,
  threadAge,
  threadElapsed,
  threadListDrafts,
  threadListGroups,
  type ThreadListGroup,
  type ThreadSupervisionRow,
  type ThreadSupervisionStatus,
} from "../../workbench/thread-supervision";
import type { UiProject } from "../../shared/contracts";
import type { DraftThread } from "../../workbench/draft-threads";
import { DraftRow, draftTitle } from "../components/DraftRow";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { projectHue, projectInitial } from "../components/ThreadRow";
import { MiddleTruncate } from "../components/ui/MiddleTruncate";
import { threadCostLabel } from "../cost-format";
import { DEFAULT_RUNTIME, threadOnPlan } from "../runtime-marks";
import { useClientStorage } from "../client-storage-context";
import { useHostClient } from "../host-client-context";
import { commandRefusal, useHostCapabilities } from "../use-host-capabilities";
import { usePreferences } from "../renderer-services-context";
import { useThreadStore } from "../workbench-context";
import { ActionSheet, type SheetAction } from "./ActionSheet";
import { SwipeRow, type SwipeAction } from "./SwipeRow";

/** What the project line's right edge says when the thread needs a look, in the desktop rail's colours. */
const STATUS_SHORT: Partial<Record<ThreadSupervisionStatus, string>> = { waiting: "Waiting", failed: "Failed" };
const STATUS_CLASS: Record<ThreadSupervisionStatus, string> = { waiting: "status-waiting", running: "status-working", failed: "status-failed", done: "" };

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The state when the thread needs a look or runs, else its age: the desktop row's project line. */
function RowTime({ row }: { row: ThreadSupervisionRow }) {
  const now = useNow(row.startedAt !== undefined);
  if (row.status === "running") {
    return <span className="thread-status-age status-working"><i />{row.startedAt !== undefined ? <time>{threadElapsed(row.startedAt, now)}</time> : "Working"}</span>;
  }
  const short = STATUS_SHORT[row.status];
  if (short) return <span className={`thread-status-age ${STATUS_CLASS[row.status]}`}>{short}</span>;
  if (row.unread && !row.settled) return <span className="thread-status-age status-ready">Ready</span>;
  return <time dateTime={new Date(row.modifiedAt).toISOString()}>{threadAge(row.modifiedAt, now)}</time>;
}

/** Whether this client has the settled shelf open; folded is the default, as in T3 Code. */
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
 * tap to open and a swipe to settle, as in T3 Code's thread list. A long
 * press (or a right click) lists every action, the kits' `thread-row`
 * commands among them. Running rows keep a stop button: supervision on a
 * phone means stopping a run without opening it.
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
  const [settledOpen, setSettledOpen] = useState(() => clientStorage.get(SETTLED_OPEN_KEY) === "true");
  const toggleSettled = () => setSettledOpen((open) => {
    clientStorage.set(SETTLED_OPEN_KEY, String(!open));
    return !open;
  });
  const groups = useMemo(
    () => threadListGroups(snapshot.threads, current, { pinned: pinnedThreadIds, settled: settledThreadIds, shown, ...(project ? { project } : {}) }),
    [current, pinnedThreadIds, project, settledThreadIds, shown, snapshot.threads],
  );
  const rowCommands = registry.getCommandsFor("thread-row");
  const runCommand = (id: string, threadId: string) => {
    const command = rowCommands.find((entry) => entry.id === id);
    if (command) void Promise.resolve(command.run(actions, { threadId })).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
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
  const sheetActions = (row: ThreadSupervisionRow): SheetAction[] => [
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
  const connection = link.state === "connected" ? null : <ConnectionNotice state={link.state} refusal={link.refusal} empty={groups.length === 0} />;
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
    // A Read-only device may not stop a run; the row's sheet says why.
    ...(readOnly ? {} : { onStop }),
    onSheet: setSheetFor,
    showCosts,
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
  // One scroll, as the desktop rail: the settled shelf follows the active threads and sits at the bottom while those are few.
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
            <span>{settledOpen ? "Settled" : `Settled · ${settledCount}`}</span><i /><ChevronDown size={14} aria-hidden />
          </button>
          {settledOpen ? <ul className="touch-thread-list" aria-label="Settled threads">
            <GroupRows group={{ ...settled, label: "" }} {...rowProps} onMore={more(settled)} />
          </ul> : null}
        </div> : null}
      </div>
    </div>
    {sheetFor ? <ActionSheet title={sheetFor.title} actions={sheetActions(sheetFor)} onClose={() => setSheetFor(undefined)} /> : null}
    {draftSheet ? <ActionSheet title={draftTitle(draftSheet)} actions={draftSheetActions(draftSheet)} onClose={() => setDraftSheet(undefined)} /> : null}
  </>;
}

const CONNECTION_TEXT: Record<"reconnecting" | "resyncing" | "refused", { title: string; detail: string }> = {
  reconnecting: { title: "Not connected", detail: "The list shows what the host last sent. Tau reconnects on its own." },
  resyncing: { title: "Updating", detail: "Refetching the threads from the host…" },
  refused: { title: "The host refused this device", detail: "Pair it again from the host's Settings → Connections." },
};

function useConnectionState() {
  const client = useHostClient();
  const subscribe = useCallback((listener: () => void) => client?.onConnectionState(listener) ?? (() => undefined), [client]);
  const state = useSyncExternalStore(subscribe, () => client?.getConnectionState() ?? "connected");
  return { state, refusal: state === "refused" ? client?.getConnectionRefusal() : undefined };
}

/** A list that may be stale says so; one that never loaded says it is waiting for the host. */
function ConnectionNotice({ state, refusal, empty }: { state: keyof typeof CONNECTION_TEXT; refusal?: string | undefined; empty: boolean }) {
  const text = empty && state !== "refused" ? { title: "Connecting to the host…", detail: "Threads appear once it answers." } : CONNECTION_TEXT[state];
  return <p className={`touch-thread-notice ${state}`} role={state === "refused" ? "alert" : "status"}>
    <strong>{text.title}</strong>
    <span>{refusal || text.detail}</span>
  </p>;
}

/** "Snooze thread…" becomes "Snooze" under a swipe glyph. */
function shortLabel(label: string): string {
  return label.replace(/…$/u, "").replace(/\s+thread$/iu, "");
}

function GroupRows({ group, activeId, openRow, setOpenRow, swipeActions, onOpen, onStop, onSheet, onMore, showCosts }: {
  group: ThreadListGroup;
  activeId: string;
  openRow?: string | undefined;
  setOpenRow(id: string | undefined): void;
  swipeActions(row: ThreadSupervisionRow): SwipeAction[];
  onOpen(row: ThreadSupervisionRow): void;
  onStop?(row: ThreadSupervisionRow): void;
  onSheet(row: ThreadSupervisionRow): void;
  onMore(): void;
  showCosts: boolean;
}) {
  return <>
    {group.label ? <li role="none" className="touch-thread-group"><span>{group.label}</span></li> : null}
    {group.rows.map((row) => {
      const active = row.id === activeId;
      return <li key={row.id} className="touch-thread-row" data-status={row.status} data-active={active || undefined} data-settled={row.settled || undefined}>
        <SwipeRow
          actions={swipeActions(row)}
          open={openRow === row.id}
          onOpenChange={(open) => setOpenRow(open ? row.id : undefined)}
          onLongPress={() => { setOpenRow(undefined); onSheet(row); }}
        >
          <div className={`thread-row${row.settled ? " compact" : ""}${active ? " active" : ""}`}>
            <ThreadCard row={row} showCost={showCosts} onOpen={() => onOpen(row)} />
            {row.status === "running" && onStop ? <button
              type="button"
              className="touch-thread-stop"
              aria-label={`Stop ${row.title}`}
              onClick={() => onStop(row)}
            ><Square size={12} /></button> : null}
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

/**
 * A thread as the desktop rail's card draws it: the project line with the
 * state or age, the title, and the branch, cost and runtime; a settled one
 * as the rail's slim row.
 */
function ThreadCard({ row, showCost, onOpen }: { row: ThreadSupervisionRow; showCost: boolean; onOpen(): void }) {
  const mark = <i className="thread-project-icon" style={{ "--project-hue": projectHue(row.projectPath ?? row.projectName) } as CSSProperties}>{projectInitial(row.projectName)}</i>;
  const label = { "aria-label": `Open thread ${row.title}`, "aria-description": THREAD_SUPERVISION_LABELS[row.status] };
  if (row.settled) {
    return <button type="button" className="thread-main touch-thread-open" {...label} onClick={onOpen}>
      {mark}
      <span className="thread-title">{row.title}</span>
      <RowTime row={row} />
    </button>;
  }
  const cost = showCost ? threadCostLabel(row.usage) : undefined;
  const branch = row.projectLabel && !DEFAULT_BRANCHES.has(row.projectLabel) ? row.projectLabel : undefined;
  return <button type="button" className="thread-main touch-thread-open" {...label} onClick={onOpen}>
    <span className="thread-project-line">
      {mark}
      <strong>{row.projectName}</strong>
      <RowTime row={row} />
    </span>
    <span className="thread-title">{row.title}</span>
    {/* Right to left, as the rail's card: the branch yields first, the runtime mark last. */}
    <span className="thread-meta-line">
      <span className="thread-meta-end">
        {cost ? <span className="thread-cost-meta">{cost}</span> : null}
        <ProviderIconStack modelProvider={row.modelProvider} runtimeProvider={row.backendKind ?? DEFAULT_RUNTIME} plan={threadOnPlan(row.usage)} className="touch-thread-provider" hint={{ side: "left" }} />
      </span>
      {row.pinned ? <span className="thread-meta-marks"><Pin size={12} className="touch-thread-pin" aria-label="Pinned" /></span> : null}
      {branch ? <MiddleTruncate className="thread-branch" value={branch} /> : null}
    </span>
  </button>;
}
