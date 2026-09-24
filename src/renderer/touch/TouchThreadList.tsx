import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, CircleAlert, LoaderCircle, Mail, MailOpen, MessageCircleQuestion, Pin, PinOff, RotateCcw, Square } from "lucide-react";
import {
  THREAD_LIST_PAGE,
  THREAD_SUPERVISION_LABELS,
  threadAge,
  threadElapsed,
  threadListGroups,
  type ThreadListGroup,
  type ThreadSupervisionRow,
  type ThreadSupervisionStatus,
} from "../../workbench/thread-supervision";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { useHostClient } from "../host-client-context";
import { READ_ONLY_REASON, useHostCapabilities } from "../use-host-capabilities";
import { usePreferences } from "../renderer-services-context";
import { useThreadStore } from "../workbench-context";
import { ActionSheet, type SheetAction } from "./ActionSheet";
import { SwipeRow, type SwipeAction } from "./SwipeRow";

const STATUS_ICON: Record<ThreadSupervisionStatus, typeof Check | undefined> = {
  waiting: MessageCircleQuestion,
  running: LoaderCircle,
  failed: CircleAlert,
  done: undefined,
};

/** What the right edge of a row says: the state when it needs a look, else the age. */
const STATUS_SHORT: Partial<Record<ThreadSupervisionStatus, string>> = { waiting: "Waiting", failed: "Failed" };

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function RowTime({ row }: { row: ThreadSupervisionRow }) {
  const now = useNow(row.startedAt !== undefined);
  if (row.status === "running" && row.startedAt !== undefined) return <time>{threadElapsed(row.startedAt, now)}</time>;
  const short = STATUS_SHORT[row.status];
  return short ? <em>{short}</em> : <time dateTime={new Date(row.modifiedAt).toISOString()}>{threadAge(row.modifiedAt, now)}</time>;
}

export interface TouchThreadListProps {
  registry: ExtensionRegistry;
  actions: WorkbenchActions;
  onOpen(row: ThreadSupervisionRow): void;
  onStop(row: ThreadSupervisionRow): void;
  /** Active rows before "Show more"; the start screen keeps it short. */
  pageSize?: number;
  /** The next step the empty list offers; absent, the empty list only says so. */
  onNewThread?(): void;
}

/**
 * The compact thread list: pinned, active and settled threads, each row a
 * tap to open and a swipe to settle, as in T3 Code's thread list. A long
 * press (or a right click) lists every action, the kits' `thread-row`
 * commands among them. Running rows keep a stop button: supervision on a
 * phone means stopping a run without opening it.
 */
export function TouchThreadList({ registry, actions, onOpen, onStop, onNewThread, pageSize = THREAD_LIST_PAGE.active }: TouchThreadListProps) {
  const store = useThreadStore();
  const preferences = usePreferences();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const current = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const { pinnedThreadIds, settledThreadIds } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [shown, setShown] = useState({ active: pageSize, settled: THREAD_LIST_PAGE.settled });
  const [openRow, setOpenRow] = useState<string>();
  const [sheetFor, setSheetFor] = useState<ThreadSupervisionRow>();
  const groups = useMemo(
    () => threadListGroups(snapshot.threads, current, { pinned: pinnedThreadIds, settled: settledThreadIds, shown }),
    [current, pinnedThreadIds, settledThreadIds, shown, snapshot.threads],
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
  const refused = (command?: { access?: "read" }) => readOnly && command?.access !== "read" ? READ_ONLY_REASON : undefined;
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
  if (groups.length === 0) {
    return <>
      {connection}
      {connection ? null : <div className="touch-thread-empty">
        <strong>No threads yet</strong>
        <span>Start a thread to work in one of your projects.</span>
        {onNewThread && !readOnly ? <button type="button" onClick={onNewThread}>New thread</button> : null}
      </div>}
    </>;
  }
  return <>
    {connection}
    <ul className="touch-thread-list" aria-label="Threads" onScroll={() => setOpenRow(undefined)}>
      {groups.map((group) => <GroupRows
        key={group.id}
        group={group}
        activeId={current.activeThreadId}
        openRow={openRow}
        setOpenRow={setOpenRow}
        swipeActions={swipeActions}
        onOpen={onOpen}
        // A Read-only device may not stop a run; the row's sheet says why.
        {...(readOnly ? {} : { onStop })}
        onSheet={setSheetFor}
        onMore={() => setShown((value) => group.id === "settled"
          ? { ...value, settled: value.settled + 25 }
          : { ...value, active: value.active + THREAD_LIST_PAGE.active })}
      />)}
    </ul>
    {sheetFor ? <ActionSheet title={sheetFor.title} actions={sheetActions(sheetFor)} onClose={() => setSheetFor(undefined)} /> : null}
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

function GroupRows({ group, activeId, openRow, setOpenRow, swipeActions, onOpen, onStop, onSheet, onMore }: {
  group: ThreadListGroup;
  activeId: string;
  openRow?: string;
  setOpenRow(id: string | undefined): void;
  swipeActions(row: ThreadSupervisionRow): SwipeAction[];
  onOpen(row: ThreadSupervisionRow): void;
  onStop?(row: ThreadSupervisionRow): void;
  onSheet(row: ThreadSupervisionRow): void;
  onMore(): void;
}) {
  return <>
    {group.label ? <li role="none" className="touch-thread-group"><span>{group.label}</span></li> : null}
    {group.rows.map((row) => {
      const Icon = STATUS_ICON[row.status];
      return <li key={row.id} className="touch-thread-row" data-status={row.status} data-active={row.id === activeId || undefined} data-settled={row.settled || undefined}>
        <SwipeRow
          actions={swipeActions(row)}
          open={openRow === row.id}
          onOpenChange={(open) => setOpenRow(open ? row.id : undefined)}
          onLongPress={() => { setOpenRow(undefined); onSheet(row); }}
        >
          <button type="button" className="touch-thread-open" aria-label={`Open thread ${row.title}`} aria-description={THREAD_SUPERVISION_LABELS[row.status]} onClick={() => onOpen(row)}>
            <span className="touch-thread-line">
              {row.unread ? <b className="touch-thread-unread" aria-label="Unread" /> : null}
              {Icon ? <i className="touch-thread-status" aria-hidden="true"><Icon size={13} /></i> : null}
              <strong>{row.title}</strong>
              <RowTime row={row} />
            </span>
            {row.settled ? null : <span className="touch-thread-meta">
              <small>{row.projectLabel ? `${row.projectName} · ${row.projectLabel}` : row.projectName}</small>
              {row.pinned ? <Pin size={11} aria-label="Pinned" /> : null}
              <ProviderIconStack modelProvider={row.modelProvider} runtimeProvider={row.backendKind} className="touch-thread-provider" hint={{ side: "left" }} />
            </span>}
          </button>
          {row.status === "running" && onStop ? <button
            type="button"
            className="touch-thread-stop"
            aria-label={`Stop ${row.title}`}
            onClick={() => onStop(row)}
          ><Square size={12} /></button> : null}
          <button type="button" className="touch-thread-more" aria-label={`Actions for ${row.title}`} onClick={() => onSheet(row)}>…</button>
        </SwipeRow>
      </li>;
    })}
    {group.hidden > 0 ? <li role="none" className="touch-thread-more-rows">
      <button type="button" onClick={onMore}>Show more ({group.hidden} {group.id === "settled" ? "settled " : ""}hidden)</button>
    </li> : null}
  </>;
}
