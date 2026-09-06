import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot } from "lucide-react";
import type { AgentThreadStatus } from "../../shared/agents-kit-protocol";
import type { PanelProps } from "../extension-system";
import { useThreadStore, useWorkbenchShell } from "../workbench-context";
import { agentsStore } from "./agents-store";
import {
  activityLine,
  agentsPanelModel,
  formatCost,
  formatElapsed,
  type AgentGroup,
  type AgentRow,
  type AgentsPanelModel,
} from "./agents-model";

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

const AgentPanelRow = memo(function AgentPanelRow({ row, onOpen }: { row: AgentRow; onOpen(row: AgentRow): void }) {
  const disabled = !row.path;
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
        <Elapsed row={row} />
      </span>
      <span className="agent-row-activity">{activityLine(row)}</span>
      <span className="agent-row-meta">
        {[row.model, formatCost(row.costUsd)].filter(Boolean).join(" · ")}
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

  const model = useMemo(
    () => agentsPanelModel(state, activeThreadId, navigation.threads),
    [state, activeThreadId, navigation.threads],
  );
  const rows = useMemo(() => panelRows(model), [model]);

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => rows[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 6,
  });

  const open = useCallback((row: AgentRow) => {
    if (row.path) void actions.switchSession(row.path);
  }, [actions]);

  return (
    <section className="panel-body agents-panel">
      <PanelHeader model={model} extensionName={extensionName} />
      {rows.length === 0 ? (
        <div className="agents-empty">
          <Bot size={22} aria-hidden="true" />
          <p>No agents yet</p>
          <small>When this thread spawns sub-agents with tau_spawn_thread, they appear here with live status and their answer.</small>
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
                    : <AgentPanelRow row={row.row} onOpen={open} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {model.runningElsewhere > 0 && model.jumpTo ? (
        <footer className="agents-elsewhere">
          <span>{model.runningElsewhere} agent{model.runningElsewhere === 1 ? "" : "s"} in other threads</span>
          <button
            type="button"
            disabled={!model.jumpTo.path}
            onClick={() => { if (model.jumpTo?.path) void actions.switchSession(model.jumpTo.path); }}
          >Go to {model.jumpTo.title}</button>
        </footer>
      ) : null}
    </section>
  );
}
