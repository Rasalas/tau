import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp, CircleHelp, CircleSlash, CircleX, Clock, CornerUpLeft, Ellipsis, Plus, Square } from "lucide-react";
import { Popover, tooltipProps, useHostCapabilities, useThreadStore, useWorkbench, type RegionProps, type WorkbenchActions } from "tau";
import { agentHoverText, agentsPanelModel, canStopRow, lineageSections, nativeAgentRow, nativeAgentTools, formatElapsed, type AgentRow } from "./model.js";
import { openAgent, subagentKey, useOpenedSubagent } from "./subagent-view.js";
import { DefinitionsSection } from "./definitions-panel.js";
import { isBusyStatus } from "./protocol.js";
import { stopAgent } from "./stop.js";
import { agentsStore, definitionsStore, siblingsSource } from "./store.js";
import { AgentProviderMark, AgentTranscriptElapsed } from "./transcript-marks.js";

/** Optional contribution seam of the Workspace kit. */
export interface WorkspaceSummaryService {
  registerWorkspaceSummarySection?(section: ComponentType<RegionProps>, position?: "footer"): () => void;
}

const STATUS = { running: "Running", waiting: "Needs your answer", pending: "Queued", completed: "Completed", idle: "Idle", failed: "Failed", cancelled: "Cancelled" };

function Elapsed({ row }: { row: AgentRow }) {
  const [now, setNow] = useState(Date.now);
  const live = isBusyStatus(row.status);
  useEffect(() => {
    if (!live || !row.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, row.startedAt]);
  return row.startedAt && (live || row.endedAt) ? <time className="workspace-card-accessory agent-lineage-time">{formatElapsed(Math.max(0, (row.endedAt ?? (live ? now : row.startedAt)) - row.startedAt))}</time> : null;
}

/** The same compact row in the project card and in a spawn's inline list. */
export function AgentLineageRow({ row, actions, current = false, transcript = false }: { row: AgentRow; actions: WorkbenchActions; current?: boolean; transcript?: boolean }) {
  const shown = useOpenedSubagent() === subagentKey(row);
  const status = STATUS[row.status];
  const icon = row.status === "running" ? <span className="spinner small" />
    : row.status === "waiting" ? <CircleHelp /> : row.status === "pending" ? <Clock />
    : row.status === "failed" ? <CircleX /> : row.status === "cancelled" ? <CircleSlash /> : <Check />;
  const open = () => openAgent(row, actions);
  const { readOnly } = useHostCapabilities();
  const [stopping, setStopping] = useState(false);
  const stoppable = canStopRow(row) && !readOnly;
  const stop = () => { setStopping(true); void stopAgent(row, actions).finally(() => setStopping(false)); };
  const button = <button type="button" className={`${transcript ? "agent-transcript-row" : "workspace-card-row agent-lineage-row"} status-${row.status}`} disabled={row.native ? !actions.openConversationView : !row.threadId && !row.machine?.thread} aria-current={current || shown ? "page" : undefined} aria-label={`${row.title}, ${status}`} {...tooltipProps(agentHoverText(row), { variant: "lines", side: "left" })} onClick={open}>
    {transcript ? <span className="agent-transcript-avatar"><AgentProviderMark row={row} /><span className="agent-transcript-dot" aria-hidden /></span>
      : <span className="workspace-card-icon agent-lineage-provider" aria-hidden><AgentProviderMark row={row} /></span>}
    {transcript ? <span className="agent-transcript-main"><strong>{row.title}</strong><span className="agent-transcript-status">{status}</span></span> : <span className="workspace-card-label">{row.title}</span>}
    {transcript ? <AgentTranscriptElapsed rows={[row]} /> : <Elapsed row={row} />}
    {transcript ? <ChevronRight className="agent-transcript-chevron" size={16} aria-hidden /> : <span className="workspace-card-tail agent-lineage-status" {...tooltipProps(status)} aria-hidden>{icon}</span>}
  </button>;
  if (!stoppable) return button;
  // The stop sits beside the row, not in it: a button cannot hold a button. It takes the timer's place.
  return <div className={`agent-lineage-item has-stop${transcript ? " agent-transcript-item" : ""}`}>
    {button}
    <button type="button" className="agent-lineage-stop" aria-label={`Stop ${row.title}`} disabled={stopping} {...tooltipProps("Stop agent and its sub-agents", { side: "left" })} onClick={stop}><Square size={12} fill="currentColor" aria-hidden /></button>
  </div>;
}

/** The current thread's parent and children, including persisted links after a restart. */
export function AgentLineage({ snapshot, actions }: RegionProps) {
  const { tools } = useWorkbench();
  const history = snapshot?.turnActivityHistory;
  const nativeRows = useMemo(() => [...nativeAgentTools(history, tools).values()].flatMap((tool) => { const row = nativeAgentRow(tool); return row ? [row] : []; }), [history, tools]);
  const threadStore = useThreadStore();
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const navigation = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
  const activity = useSyncExternalStore(threadStore.subscribeToActivity, threadStore.getActivity);
  const version = useSyncExternalStore(siblingsSource.subscribe, siblingsSource.getVersion);
  const id = snapshot?.sessionId;
  const definitions = useSyncExternalStore(definitionsStore.subscribe, definitionsStore.getSnapshot);
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const definitionsAnchor = useRef<HTMLButtonElement>(null);
  useEffect(() => { setDefinitionsOpen(false); void definitionsStore.load(id).catch(() => undefined); }, [id]);
  const hasDefinitions = Boolean(definitions.state?.definitions.length || definitions.state?.problems.length);
  const siblings = useMemo(() => id ? siblingsSource.siblingsOf(id) : [], [id, version]);
  const model = useMemo(() => agentsPanelModel(state, id, navigation.threads, { ids: siblings, running: activity.runningThreadIds }), [state, id, navigation.threads, siblings, activity.runningThreadIds]);
  const parentId = state?.links.find((link) => link.threadId === id)?.parentThreadId ?? navigation.threads.find((thread) => thread.id === id)?.parentThreadId;
  const parent = navigation.threads.find((thread) => thread.id === parentId);
  const sections = useMemo(() => lineageSections(nativeRows, model.groups), [nativeRows, model.groups]);
  const opened = useOpenedSubagent();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [id]);
  // A finished child opened from elsewhere (its spawn card) is shown in the card too.
  const openedIn = opened ? sections.find((section) => section.previous.some((row) => subagentKey(row) === opened))?.key : undefined;
  useEffect(() => {
    if (openedIn) setExpanded((current) => current.has(openedIn) ? current : new Set(current).add(openedIn));
  }, [openedIn]);
  if (!id || (!parentId && !sections.length && !hasDefinitions)) return null;
  const enriched = (row: AgentRow): AgentRow => {
    const thread = navigation.threads.find((entry) => entry.id === row.threadId);
    return row.model || !thread?.modelProvider ? row : { ...row, model: `${thread.modelProvider}/${thread.model ?? ""}` };
  };
  const rows = (items: readonly AgentRow[]) => items.map((row) => <AgentLineageRow key={row.id} row={enriched(row)} actions={actions} current={row.threadId === id} />);
  const running = sections.reduce((count, section) => count + section.active.filter((row) => row.status === "running").length, 0);
  const toggle = (key: string) => setExpanded((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  return <section className="agent-lineage" aria-label="Agents">
    <div className="agent-lineage-heading"><span>{running ? `Agents · ${running} running` : "Agents"}</span>{hasDefinitions ? <button ref={definitionsAnchor} type="button" aria-label="Agent definitions" aria-haspopup="dialog" aria-expanded={definitionsOpen} onClick={() => setDefinitionsOpen((open) => !open)}><Ellipsis size={16} /></button> : null}</div>
    {definitionsOpen ? <Popover anchor={definitionsAnchor} label="Agent definitions" onClose={() => setDefinitionsOpen(false)}><DefinitionsSection state={state} activeThreadId={id} actions={actions} /></Popover> : null}
    {parentId ? <button type="button" className="workspace-card-row agent-lineage-parent" aria-label={`Back to ${parent?.title ?? "parent thread"}`} disabled={!parent?.path} onClick={() => { if (parent?.path) void actions.switchSession(parent.path); }}>
      <CornerUpLeft aria-hidden /><span className="workspace-card-label">Back to {parent?.title ?? "parent thread"}</span>
    </button> : null}
    {sections.map((section) => <div key={section.key}>
      {section.label ? <div className="agent-lineage-group">{section.label}</div> : null}
      {section.active.length ? <div className="agent-lineage-list">{rows(section.active)}</div> : null}
      {section.previous.length ? <PreviousAgents key={`${id}:${section.key}`} rows={section.previous} open={expanded.has(section.key)} onToggle={() => toggle(section.key)}>{rows}</PreviousAgents> : null}
    </div>)}
  </section>;
}

/** Finished agents shown at first, and per "Show more" (T3 Code's lineage paging). */
const PREVIOUS_FIRST = 6;
const PREVIOUS_PAGE = 12;

/** Finished agents fold under one row, as in T3 Code; open, they page so a long run never buries the card. */
function PreviousAgents({ rows, open, onToggle, children }: { rows: readonly AgentRow[]; open: boolean; onToggle(): void; children(rows: readonly AgentRow[]): ReactNode }) {
  const [shown, setShown] = useState(PREVIOUS_FIRST);
  const failed = rows.filter((row) => row.status === "failed").length;
  const hidden = rows.length - Math.min(shown, rows.length);
  return <>
    <button type="button" className="workspace-card-row agent-lineage-toggle" aria-expanded={open} onClick={onToggle}>
      <span className="workspace-card-label">Previous agents{open ? "" : ` (${rows.length})`}</span>
      {failed ? <span className="agent-lineage-failed">{failed} failed</span> : null}
      <span className="workspace-card-tail">{open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}</span>
    </button>
    {open ? <>
      <div className="agent-lineage-list">{children(rows.slice(0, shown))}</div>
      {hidden ? <button type="button" className="workspace-card-row agent-lineage-more" onClick={() => setShown((count) => count + PREVIOUS_PAGE)}>
        <Plus aria-hidden /><span className="workspace-card-label">Show {Math.min(hidden, PREVIOUS_PAGE)} more</span>
      </button> : null}
    </> : null}
  </>;
}

/** Compact clients have no project card; the same lineage opens from the thread header. */
export function CompactLineage(props: RegionProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { tools } = useWorkbench();
  const native = tools.some((tool) => tool.kind === "subagent") || props.snapshot?.turnActivityHistory?.some((entry) => entry.tools.some((tool) => tool.kind === "subagent"));
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const store = useThreadStore();
  const navigation = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const id = props.snapshot?.sessionId;
  const opened = useOpenedSubagent();
  useEffect(() => setOpen(false), [id, opened]);
  if (!id || !(native || state?.links.some((link) => link.threadId === id || link.parentThreadId === id) || navigation.threads.some((thread) => thread.id === id && thread.parentThreadId || thread.parentThreadId === id))) return null;
  return <span className="menu-anchor"><button ref={anchor} type="button" className="thread-detail" aria-label="Thread agents" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Bot size={16} /> Agents</button>
    {open ? <Popover anchor={anchor} label="Thread agents" onClose={() => setOpen(false)}><div className="workspace-summary-card"><AgentLineage {...props} /></div></Popover> : null}
  </span>;
}
