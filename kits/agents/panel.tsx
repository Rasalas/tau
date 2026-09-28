import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Server } from "lucide-react";
import { tooltipProps, useHostCapabilities, useThreadStore, useWorkbenchShell, type PanelProps } from "tau";
import { agentsHost, agentsStore, definitionsStore, siblingsSource } from "./store.js";
import { DefinitionsSection } from "./definitions-panel.js";
import {
  agentsPanelModel,
  canSettleWorktree,
  doneLabel,
  formatCost,
  formatElapsed,
  machineTitle,
  questionLine,
  rowStand,
  shortModel,
  viewRows,
  type AgentGroup,
  type AgentRow,
  type AgentRowMachine,
  type AgentsPanelModel,
  type AgentsView,
} from "./model.js";

/** Rows are one fixed height, which is what lets the list virtualize cleanly. */
const ROW_HEIGHT = 48;
const GROUP_HEIGHT = 24;
const SECTION_HEIGHT = 32;

type PanelRow =
  | { kind: "group"; key: string; group: AgentGroup }
  | { kind: "section"; key: string; label: string }
  | { kind: "agent"; key: string; row: AgentRow };

/** What one view lists: per parent, its questions and work, then its finished agents by turn. */
export function panelRows(model: AgentsPanelModel, view: AgentsView = "running"): PanelRow[] {
  return model.groups.flatMap((group) => {
    const { open, done } = viewRows(group.rows, view);
    if (open.length === 0 && done.length === 0) return [];
    return [
      ...(model.groups.length > 1 ? [{ kind: "group" as const, key: `group:${group.parentThreadId}`, group }] : []),
      ...open.map((row) => ({ kind: "agent" as const, key: row.id, row })),
      ...done.flatMap((section) => [
        { kind: "section" as const, key: `done:${group.parentThreadId}:${section.turn ?? "-"}`, label: doneLabel(section) },
        ...section.rows.map((row) => ({ kind: "agent" as const, key: row.id, row })),
      ]),
    ];
  });
}

/** The counts on the three view tabs. */
export function viewCounts(model: AgentsPanelModel): Record<AgentsView, number> {
  return {
    running: model.running + model.pending,
    asks: model.waiting,
    done: model.completed + model.failed + model.cancelled,
  };
}

/**
 * Ticks the elapsed time by writing the text node, not by re-rendering: with
 * fifty running agents a per-second React commit per row is the whole frame.
 */
function Elapsed({ row }: { row: AgentRow }) {
  const ref = useRef<HTMLTimeElement>(null);
  const live = row.status === "running" || row.status === "waiting";
  const text = useCallback(() => {
    if (!row.startedAt) return "";
    return formatElapsed((live ? Date.now() : row.endedAt ?? Date.now()) - row.startedAt);
  }, [live, row.endedAt, row.startedAt]);
  useEffect(() => {
    if (ref.current) ref.current.textContent = text();
    if (!live) return;
    const timer = window.setInterval(() => { if (ref.current) ref.current.textContent = text(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [live, text]);
  return row.startedAt ? <time ref={ref} /> : null;
}

/** The machine a row runs on: its name as a chip, why and whether it answers in the tooltip. */
export function MachineChip({ machine }: { machine: AgentRowMachine }) {
  const title = machineTitle(machine);
  return (
    <span className={`agent-row-machine${machine.offline ? " offline" : ""}`} aria-label={title} {...tooltipProps(title)}>
      <Server size={10} aria-hidden="true" />{machine.name}
    </span>
  );
}

const AgentPanelRow = memo(function AgentPanelRow({ row, onOpen, onSettle }: {
  row: AgentRow;
  onOpen(row: AgentRow): void;
  /** Takes the agent's work into this checkout, or throws it away with its worktree. */
  onSettle(row: AgentRow, outcome: "apply" | "discard"): void;
}) {
  // A row on another machine has no thread here; the tooltip says where it runs.
  const disabled = !row.path && !row.machine;
  // A Read-only device may look at an agent's work, not take or drop it (ADR 0024).
  const { readOnly } = useHostCapabilities();
  const asks = row.status === "waiting";
  const model = shortModel(row.model);
  const cost = row.costUsd === undefined ? undefined : formatCost(row.costUsd);
  return (
    <button
      type="button"
      className={`agent-row status-${row.status}`}
      disabled={disabled}
      aria-label={`${row.title}, ${asks ? "question" : row.status}`}
      {...(row.result && !asks ? { title: row.result } : {})}
      onClick={() => onOpen(row)}
    >
      <span className="agent-row-head">
        <strong>{row.title}</strong>
        {row.agent ? <span className="agent-row-definition" title={`Started from the agent definition ${row.agent}`}>{row.agent}</span> : null}
        {row.machine ? <MachineChip machine={row.machine} /> : null}
      </span>
      {asks ? <span className="agent-row-sub question">{questionLine(row)}</span> : (
        <span className="agent-row-sub">
          <span className="agent-row-sub-text">
            {model ? <span title={row.model}>{model}</span> : null}
            <Elapsed row={row} />
            {cost ? <span>{cost}</span> : null}
            <span className="agent-row-stand">{rowStand(row)}</span>
          </span>
          {canSettleWorktree(row) && !readOnly ? (
            <span className="agent-row-actions">
              <span role="button" tabIndex={-1} aria-label={`Apply changes of ${row.title}`}
                onClick={(event) => { event.stopPropagation(); onSettle(row, "apply"); }}
              >Apply</span>
              <span role="button" tabIndex={-1} aria-label={`Discard changes of ${row.title}`}
                onClick={(event) => { event.stopPropagation(); onSettle(row, "discard"); }}
              >Discard</span>
            </span>
          ) : null}
        </span>
      )}
    </button>
  );
});

const VIEWS: ReadonlyArray<[AgentsView, string]> = [["running", "Running"], ["asks", "Asks"], ["done", "Done"]];

/** Running / Asks / Done, as in the workbench design; the arrows move between them. */
function PanelHeader({ model, view, onView }: { model: AgentsPanelModel; view: AgentsView; onView(view: AgentsView): void }) {
  const counts = viewCounts(model);
  const move = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = (VIEWS.findIndex(([id]) => id === view) + step + VIEWS.length) % VIEWS.length;
    onView(VIEWS[index]![0]);
    (event.currentTarget.children[index] as HTMLElement | undefined)?.focus();
  };
  return (
    <header className="panel-header agents-header">
      <h2>Agents</h2>
      <div className="agents-views" role="tablist" aria-label="Agents" onKeyDown={move}>
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} tabIndex={view === id ? 0 : -1}
            className={`agents-view view-${id}`} onClick={() => onView(id)}
          >{label} <span>{counts[id]}</span></button>
        ))}
      </div>
      <span className="spacer" />
      <span className="agent-total-cost" aria-label="Total cost">{formatCost(model.totalCostUsd)}</span>
    </header>
  );
}

const EMPTY_VIEW: Record<AgentsView, [string, string]> = {
  running: ["No agents yet", "When this thread hands work to agents, each one shows up here with what it is doing."],
  asks: ["No questions", "An agent that needs your answer shows up here."],
  done: ["Nothing finished yet", "Agents that are done stay here with what they changed."],
};

export function AgentsPanel({ actions, canLookIn }: PanelProps & {
  /** Whether this client reads another machine's thread in a stage tab (API 1.15.0). */
  canLookIn?: () => boolean;
}) {
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
  const [view, setView] = useState<AgentsView>("running");
  const rows = useMemo(() => panelRows(model, view), [model, view]);

  // The definitions of the checkout the thread on screen works in.
  useEffect(() => {
    definitionsStore.load(activeThreadId).catch(() => undefined);
  }, [activeThreadId]);

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => {
      const kind = rows[index]?.kind;
      return kind === "group" ? GROUP_HEIGHT : kind === "section" ? SECTION_HEIGHT : ROW_HEIGHT;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 6,
  });

  // A child's chat opens as a stage tab, so the composer keeps addressing the
  // thread that spawned it and the rail keeps hiding the child.
  const open = useCallback((row: AgentRow) => {
    if (row.path && row.threadId) actions.openThread(row.threadId);
    // Read over the window's connection there; an older core would read the id as this machine's thread.
    else if (row.machine?.thread && canLookIn?.()) actions.openThread(row.machine.thread, { machine: row.machine.id });
    else if (row.machine) actions.notify(`${row.title} runs on ${row.machine.name}; its transcript is there.`);
  }, [actions, canLookIn]);

  // The same two moves tau_apply_thread_changes makes, for the user.
  const settle = useCallback((row: AgentRow, outcome: "apply" | "discard") => {
    const handle = row.threadId ?? (row.machine ? row.id : undefined);
    if (!handle) return;
    void agentsHost.invoke?.(outcome === "apply" ? "apply-changes" : "discard-changes", { threadId: handle })
      .then((result) => actions.notify((result as { detail?: string } | undefined)?.detail ?? "Done."))
      .catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error)));
  }, [actions]);

  const empty = EMPTY_VIEW[model.groups.length > 0 ? view : "running"];
  return (
    <section className="panel-body agents-panel">
      {model.groups.length > 0 ? <PanelHeader model={model} view={view} onView={setView} /> : null}
      <DefinitionsSection state={state} activeThreadId={activeThreadId} actions={actions} />
      {rows.length === 0 ? (
        <div className="agents-empty">
          <Bot size={22} aria-hidden="true" />
          <p>{empty[0]}</p>
          <small>{empty[1]}</small>
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
                  {row.kind === "group" ? <div className="agent-group-label">{row.group.active ? "This thread" : row.group.parentTitle}</div>
                    : row.kind === "section" ? <div className="agent-section-label">{row.label}</div>
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
