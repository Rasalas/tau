import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, CircleCheck, CircleHelp, CircleSlash, CircleX, Clock, Server } from "lucide-react";
import { ProviderIconStack, tooltipProps, useHostCapabilities, useThreadStore, useWorkbenchShell, type PanelProps } from "tau";
import { agentsHost, agentsStore, definitionsStore, siblingsSource } from "./store.js";
import { DefinitionsSection } from "./definitions-panel.js";
import {
  agentsPanelModel,
  canSettleWorktree,
  doneLabel,
  formatCost,
  formatElapsed,
  machineTitle,
  rowStand,
  shortModel,
  viewRows,
  type AgentGroup,
  type AgentRow,
  type AgentRowMachine,
  type AgentsPanelModel,
  type AgentsView,
} from "./model.js";

/** Rows are one fixed height, which is what lets the list virtualize cleanly; a phone's are taller (design 2m). */
const ROW_HEIGHT = 48;
const SHEET_ROW_HEIGHT = 56;
const GROUP_HEIGHT = 24;
const SECTION_HEIGHT = 32;
const MORE_HEIGHT = 32;
/** Finished agents the Running view shows per turn; the rest are one "… N more" away (design 1c). */
const DONE_PREVIEW = 4;

type PanelRow =
  | { kind: "group"; key: string; group: AgentGroup }
  | { kind: "section"; key: string; label: string }
  | { kind: "more"; key: string; count: number }
  | { kind: "agent"; key: string; row: AgentRow };

export type AgentsSort = "status" | "started";

/** What one view lists: per parent, its questions and work, then its finished agents by turn. */
export function panelRows(model: AgentsPanelModel, view: AgentsView = "running", sort: AgentsSort = "status"): PanelRow[] {
  return model.groups.flatMap((group) => {
    const { open, done } = viewRows(group.rows, view, sort === "status");
    if (open.length === 0 && done.length === 0) return [];
    return [
      ...(model.groups.length > 1 ? [{ kind: "group" as const, key: `group:${group.parentThreadId}`, group }] : []),
      ...open.map((row) => ({ kind: "agent" as const, key: row.id, row })),
      ...done.flatMap((section) => {
        const key = `done:${group.parentThreadId}:${section.turn ?? "-"}`;
        const shown = view === "running" ? section.rows.slice(0, DONE_PREVIEW) : section.rows;
        return [
          { kind: "section" as const, key, label: doneLabel(section) },
          ...shown.map((row) => ({ kind: "agent" as const, key: row.id, row })),
          ...(shown.length < section.rows.length ? [{ kind: "more" as const, key: `${key}:more`, count: section.rows.length - shown.length }] : []),
        ];
      }),
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

const STATUS_NAME: Record<AgentRow["status"], string> = {
  running: "Running", waiting: "Question", pending: "Queued", completed: "Done", idle: "Done", failed: "Failed", cancelled: "Cancelled",
};

/** The state as an icon, its name in the tooltip, and the clock beside it. */
function RowStatus({ row }: { row: AgentRow }) {
  const icon = row.status === "running" ? <span className="spinner info small" aria-hidden="true" />
    : row.status === "waiting" ? <CircleHelp size={11} aria-hidden="true" />
    : row.status === "pending" ? <Clock size={11} aria-hidden="true" />
    : row.status === "failed" ? <CircleX size={11} aria-hidden="true" />
    : row.status === "cancelled" ? <CircleSlash size={11} aria-hidden="true" />
    : <CircleCheck size={11} aria-hidden="true" />;
  return <span className="agent-row-status" {...tooltipProps(STATUS_NAME[row.status])}>{icon}<Elapsed row={row} /></span>;
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
  const provider = row.model?.includes("/") ? row.model.slice(0, row.model.indexOf("/")) : undefined;
  const branch = row.workspace?.mode === "worktree" ? row.workspace.branch : undefined;
  const tip = [row.result && !asks ? row.result : undefined, branch].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      className={`agent-row status-${row.status}`}
      disabled={disabled}
      aria-label={`${row.title}, ${asks ? "question" : row.status}`}
      {...(tip ? { title: tip } : {})}
      onClick={() => onOpen(row)}
    >
      <span className="agent-row-main">
        <span className="agent-row-head">
          <strong>{row.title}</strong>
          {row.agent ? <span className="agent-row-definition" title={`Started from the agent definition ${row.agent}`}>{row.agent}</span> : null}
          {row.machine ? <MachineChip machine={row.machine} /> : null}
        </span>
        <span className={`agent-row-sub${asks ? " question" : row.status === "running" ? " tool" : ""}`}>
          <span className="agent-row-stand">{rowStand(row)}</span>
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
      </span>
      <RowStatus row={row} />
      <span className="agent-row-model">
        {provider ? <ProviderIconStack modelProvider={provider} runtimeMark={false} name={shortModel(row.model)} hint={{}} /> : null}
      </span>
      <span className="agent-row-cost">{formatCost(row.costUsd)}</span>
    </button>
  );
});

const VIEWS: ReadonlyArray<[AgentsView, string]> = [["running", "Running"], ["asks", "Questions"], ["done", "Done"]];

/** Running / Questions / Done and the sort, as in the workbench design; the arrows move between the views. */
function PanelHeader({ model, view, onView, sort, onSort }: {
  model: AgentsPanelModel;
  view: AgentsView;
  onView(view: AgentsView): void;
  /** Left out on a phone (design 2m). */
  sort?: AgentsSort;
  onSort(sort: AgentsSort): void;
}) {
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
          >{label} {counts[id]}</button>
        ))}
      </div>
      <span className="spacer" />
      {sort ? (
        <button type="button" className="agents-sort" title={sort === "status" ? "Questions first, then work, then the queue" : "In the order they were started"}
          onClick={() => onSort(sort === "status" ? "started" : "status")}
        >Sort: {sort}</button>
      ) : null}
    </header>
  );
}

const EMPTY_VIEW: Record<AgentsView, [string, string]> = {
  running: ["No agents yet", "When this thread hands work to agents, each one shows up here with what it is doing."],
  asks: ["No questions", "An agent that needs your answer shows up here."],
  done: ["Nothing finished yet", "Agents that are done stay here with what they changed."],
};

export function AgentsPanel({ actions, canLookIn, placement }: PanelProps & {
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
  const [sort, setSort] = useState<AgentsSort>("status");
  const sheet = placement === "sheet";
  const rows = useMemo(() => panelRows(model, view, sort), [model, view, sort]);

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
      return kind === "group" ? GROUP_HEIGHT : kind === "section" ? SECTION_HEIGHT : kind === "more" ? MORE_HEIGHT : sheet ? SHEET_ROW_HEIGHT : ROW_HEIGHT;
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
    <section className={`panel-body agents-panel${sheet ? " in-sheet" : ""}`}>
      {model.groups.length > 0 ? <PanelHeader model={model} view={view} onView={setView} {...(sheet ? {} : { sort })} onSort={setSort} /> : null}
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
                    : row.kind === "more" ? <button type="button" className="agent-more" onClick={() => setView("done")}>… {row.count} more</button>
                    : <AgentPanelRow row={row.row} onOpen={open} onSettle={settle} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {model.groups.length > 0 ? (
        <p className="agents-note">{sheet
          ? "Questions are answered in the thread, not here."
          : "Click an agent to open its transcript as a read-only tab. Questions from agents always arrive on the parent conversation's composer."}</p>
      ) : null}
    </section>
  );
}
