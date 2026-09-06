import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleDot, MessageCircleQuestion, Square } from "lucide-react";
import {
  THREAD_SUPERVISION_LABELS,
  threadSupervisionRows,
  type ThreadSupervisionRow,
  type ThreadSupervisionStatus,
} from "../../workbench/thread-supervision";
import { useThreadStore } from "../workbench-context";

const STATUS_ICON: Record<ThreadSupervisionStatus, typeof CircleDot | undefined> = {
  waiting: MessageCircleQuestion,
  running: CircleDot,
  failed: CircleAlert,
  done: undefined,
};

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <time>{elapsed(startedAt, now)}</time>;
}

function SupervisionRow({ row, active, onOpen, onStop }: {
  row: ThreadSupervisionRow;
  active: boolean;
  onOpen(row: ThreadSupervisionRow): void;
  onStop(row: ThreadSupervisionRow): void;
}) {
  const Icon = STATUS_ICON[row.status];
  return <li className="supervision-row" data-status={row.status} data-active={active || undefined}>
    <button type="button" aria-label={`Open thread ${row.title}`} onClick={() => onOpen(row)}>
      {Icon ? <i aria-hidden="true"><Icon size={13} /></i> : null}
      <span>
        <strong>{row.title}</strong>
        <small>{row.projectName}</small>
      </span>
      <em data-status={row.status}>
        {THREAD_SUPERVISION_LABELS[row.status]}
        {row.unread && row.status === "done" ? " · unread" : ""}
      </em>
      {row.startedAt === undefined ? null : <Elapsed startedAt={row.startedAt} />}
    </button>
    {row.status === "running" ? <button
      type="button"
      className="supervision-stop"
      aria-label={`Stop ${row.title}`}
      title="Stop this run"
      onClick={() => onStop(row)}
    ><Square size={11} /></button> : null}
  </li>;
}

/**
 * Every thread and what it is doing, for a client that shows one thread at a
 * time. This is the whole of agent supervision on a phone: what needs an
 * answer is at the top, a tap opens it, and a run can always be stopped from
 * here without opening it first.
 */
export function ThreadSupervisor({ onOpen, onStop, limit }: {
  onOpen(row: ThreadSupervisionRow): void;
  onStop(row: ThreadSupervisionRow): void;
  limit?: number;
}) {
  const store = useThreadStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activity = useSyncExternalStore(store.subscribeToActivity, store.getActivity);
  const rows = useMemo(
    () => threadSupervisionRows(snapshot.threads, activity, limit),
    [activity, limit, snapshot.threads],
  );
  if (rows.length === 0) return <p className="supervision-empty">No threads yet.</p>;
  return <ul className="supervision-list" aria-label="Threads">
    {rows.map((row) => <SupervisionRow
      key={row.id}
      row={row}
      active={row.id === activity.activeThreadId}
      onOpen={onOpen}
      onStop={onStop}
    />)}
  </ul>;
}
