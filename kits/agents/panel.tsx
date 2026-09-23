import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot } from "lucide-react";
import { useThreadStore, useWorkbenchShell, type PanelProps } from "tau";
import type { AgentThreadStatus } from "./protocol.js";
import { agentsHost, agentsStore, definitionsStore, siblingsSource } from "./store.js";
import { DefinitionsSection } from "./definitions-panel.js";
import {
  activityLine,
  agentsPanelModel,
  canSettleWorktree,
  formatCost,
  formatElapsed,
  worktreeLine,
  type AgentGroup,
  type AgentRow,
  type AgentsPanelModel,
} from "./model.js";

/** Rows are one fixed height, which is what lets the list virtualize cleanly. */
const ROW_HEIGHT = 58;
const GROUP_HEIGHT = 24;

type PanelRow =
  | { kind: "group"; key: string; group: AgentGroup }
  | { kind: "agent"; key: string; row: AgentRow };

export function panelRows(model: AgentsPanelModel): PanelRow[] {
  return model.groups.flatMap((group) => [
    ...(model.groups.length > 1 ? [{ kind: "group" as const, key: `group:${group.parentThreadId}`, group }] : []),
    ...group.rows.map((row) => ({ kind: "agent" as const, key: row.id, row })),
  ]);
}

/**
 * Ticks the elapsed time by writing the text node, not by re-rendering: with
 * fifty running agents a per-second React commit per row is the whole frame.
 */
function Elapsed({ row }: { row: AgentRow }) {
  const ref = useRef<HTMLTimeElement>(null);
  const live = row.status === "running" || row.status === "waiting";
  const text = useCallback(() => {
    if (!row.startedAt) return "—";
    return formatElapsed((live ? Date.now() : row.endedAt ?? Date.now()) - row.startedAt);
  }, [live, row.endedAt, row.startedAt]);
  useEffect(() => {
    if (ref.current) ref.current.textContent = text();
    if (!live) return;
    const timer = window.setInterval(() => { if (ref.current) ref.current.textContent = text(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [live, text]);
  return <time ref={ref} />;
}

const AgentPanelRow = memo(function AgentPanelRow({ row, onOpen, onSettle }: {
  row: AgentRow;
  onOpen(row: AgentRow): void;
  /** Takes the agent's work into this checkout, or throws it away with its worktree. */
  onSettle(row: AgentRow, outcome: "apply" | "discard"): void;
}) {
  const disabled = !row.path;
  const worktree = worktreeLine(row);
  return (
    <button
      type="button"
      className={`agent-row status-${row.status}`}
      disabled={disabled}
      aria-label={`${row.title}, ${row.status}`}
      onClick={() => onOpen(row)}
    >
      <span className="agent-row-head">
        <i className={`agent-dot status-${row.status}`} aria-hidden="true" />
        <strong>{row.title}</strong>
        {row.agent ? <span className="agent-row-definition" title={`Started from the agent definition ${row.agent}`}>{row.agent}</span> : null}
        <Elapsed row={row} />
      </span>
      <span className="agent-row-activity">{activityLine(row)}</span>
      <span className="agent-row-meta">
        <span className="agent-row-meta-text">{[row.model, formatCost(row.costUsd), worktree].filter(Boolean).join(" · ")}</span>
        {canSettleWorktree(row) ? (
          <span className="agent-row-actions">
            <span role="button" tabIndex={-1} aria-label={`Apply changes of ${row.title}`}
              onClick={(event) => { event.stopPropagation(); onSettle(row, "apply"); }}
            >Apply changes</span>
            <span role="button" tabIndex={-1} aria-label={`Discard changes of ${row.title}`}
              onClick={(event) => { event.stopPropagation(); onSettle(row, "discard"); }}
            >Discard</span>
          </span>
        ) : null}
      </span>
    </button>
  );
});

function PanelHeader({ model, extensionName }: { model: AgentsPanelModel; extensionName: string }) {
  const counts: Array<[AgentThreadStatus | "pending", number]> = [
    ["running", model.running],
    ["waiting", model.waiting],
    ["pending", model.pending],
    ["completed", model.completed],
    ["failed", model.failed],
    ["cancelled", model.cancelled],
  ];
  return (
    <header className="panel-header">
      <h2>Agents</h2>
      <small>{extensionName.toLowerCase()}</small>
      <span className="spacer" />
      <span className="agent-counts">
        {counts.filter(([, count]) => count > 0).map(([status, count]) => (
          <span key={status} className={`agent-count status-${status}`}>
            <i aria-hidden="true" />{count} {status}
          </span>
        ))}
        <span className="agent-total-cost" aria-label="Total cost">{formatCost(model.totalCostUsd)}</span>
      </span>
    </header>
  );
}

export function AgentsPanel({ extensionName, actions }: PanelProps) {
  const { snapshot } = useWorkbenchShell();
  const threadStore = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
  const activeThreadId = snapshot?.sessionId;

  const siblingsVersion = useSyncExternalStore(siblingsSource.subscribe, siblingsSource.getVersion);
  const activity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const siblingIds = useMemo(
    () => (activeThreadId ? siblingsSource.siblingsOf(activeThreadId) : []),
    // siblingsVersion moves when Thread Rail's groups change.
    [activeThreadId, siblingsVersion],
  );
  const model = useMemo(
    () => agentsPanelModel(state, activeThreadId, navigation.threads, { ids: siblingIds, running: activity.runningThreadIds }),
    [state, activeThreadId, navigation.threads, siblingIds, activity.runningThreadIds],
  );
  const rows = useMemo(() => panelRows(model), [model]);

  // The definitions of the checkout the thread on screen works in.
  useEffect(() => {
    definitionsStore.load(activeThreadId).catch(() => undefined);
  }, [activeThreadId]);

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => rows[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 6,
  });

  // A child's chat opens as a stage tab, so the composer keeps addressing the
  // thread that spawned it and the rail keeps hiding the child.
  const open = useCallback((row: AgentRow) => {
    if (row.path && row.threadId) actions.openThread(row.threadId);
  }, [actions]);

  // The same two moves tau_apply_thread_changes makes, for the user.
  const settle = useCallback((row: AgentRow, outcome: "apply" | "discard") => {
    if (!row.threadId) return;
    void agentsHost.invoke?.(outcome === "apply" ? "apply-changes" : "discard-changes", { threadId: row.threadId })
      .then((result) => actions.notify((result as { detail?: string } | undefined)?.detail ?? "Done."))
      .catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
  }, [actions]);

  return (
    <section className="panel-body agents-panel">
      <PanelHeader model={model} extensionName={extensionName} />
      <DefinitionsSection state={state} activeThreadId={activeThreadId} actions={actions} />
      {rows.length === 0 ? (
        <div className="agents-empty">
          <Bot size={22} aria-hidden="true" />
          <p>No agents yet</p>
          <small>When this thread spawns sub-agents with tau_spawn_thread, or you start one from a definition in .tau/agents/, they appear here with live status and their answer.</small>
        </div>
      ) : (
        <div className="agent-list" ref={listRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "group"
                    ? <div className="agent-group-label">{row.group.active ? "This thread" : row.group.parentTitle}</div>
                    : <AgentPanelRow row={row.row} onOpen={open} onSettle={settle} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
