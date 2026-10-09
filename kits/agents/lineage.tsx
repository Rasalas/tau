import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { Bot, Check, ChevronDown, ChevronUp, CircleHelp, CircleSlash, CircleX, Clock, CornerUpLeft, Ellipsis } from "lucide-react";
import { Popover, ProviderIconStack, tooltipProps, useThreadStore, useWorkbench, type RegionProps, type WorkbenchActions } from "tau";
import { agentsPanelModel, nativeAgentRow, nativeAgentTools, formatElapsed, type AgentRow } from "./model.js";
import { openAgent, subagentKey, useOpenedSubagent } from "./subagent-view.js";
import { DefinitionsSection } from "./definitions-panel.js";
import { isBusyStatus } from "./protocol.js";
import { agentsStore, definitionsStore, siblingsSource } from "./store.js";

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
export function AgentLineageRow({ row, actions, current = false }: { row: AgentRow; actions: WorkbenchActions; current?: boolean }) {
  const shown = useOpenedSubagent() === subagentKey(row);
  const provider = row.model?.includes("/") ? row.model.slice(0, row.model.indexOf("/")) : undefined;
  const status = STATUS[row.status];
  const icon = row.status === "running" ? <span className="spinner small" />
    : row.status === "waiting" ? <CircleHelp /> : row.status === "pending" ? <Clock />
    : row.status === "failed" ? <CircleX /> : row.status === "cancelled" ? <CircleSlash /> : <Check />;
  const open = () => openAgent(row, actions);
  return <button type="button" className={`workspace-card-row agent-lineage-row status-${row.status}`} disabled={row.native ? !actions.openConversationView : !row.threadId && !row.machine?.thread} aria-current={current || shown ? "page" : undefined} aria-label={`${row.title}, ${status}`} title={row.machine ? `${row.title} · ${row.machine.name}${row.machine.offline ? " · Offline" : ""}` : row.title} onClick={open}>
    <span className="workspace-card-icon agent-lineage-provider" aria-hidden>{provider ? <ProviderIconStack modelProvider={provider} runtimeMark={false} hint={false} /> : <Bot />}</span>
    <span className="workspace-card-label">{row.title}</span>
    <Elapsed row={row} />
    <span className="workspace-card-tail agent-lineage-status" {...tooltipProps(status)} aria-hidden>{icon}</span>
  </button>;
}

/** The current thread's parent and children, including persisted links after a restart. */
export function AgentLineage({ snapshot, actions }: RegionProps) {
  const { tools } = useWorkbench();
  const nativeRows = [...nativeAgentTools(snapshot?.turnActivityHistory, tools).values()].flatMap((tool) => { const row = nativeAgentRow(tool); return row ? [row] : []; });
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [id]);
  if (!id || (!parentId && !model.groups.length && !hasDefinitions && !nativeRows.length)) return null;
  const enriched = (row: AgentRow): AgentRow => {
    const thread = navigation.threads.find((entry) => entry.id === row.threadId);
    return row.model || !thread?.modelProvider ? row : { ...row, model: `${thread.modelProvider}/` };
  };
  const rows = (items: AgentRow[]) => items.map((row) => <AgentLineageRow key={row.id} row={enriched(row)} actions={actions} current={row.threadId === id} />);
  return <section className="agent-lineage" aria-label="Agents">
    <div className="agent-lineage-heading"><span>Agents</span>{hasDefinitions ? <button ref={definitionsAnchor} type="button" aria-label="Agent definitions" aria-haspopup="dialog" aria-expanded={definitionsOpen} onClick={() => setDefinitionsOpen((open) => !open)}><Ellipsis size={16} /></button> : null}</div>
    {definitionsOpen ? <Popover anchor={definitionsAnchor} label="Agent definitions" onClose={() => setDefinitionsOpen(false)}><DefinitionsSection state={state} activeThreadId={id} actions={actions} /></Popover> : null}
    {parentId ? <button type="button" className="workspace-card-row agent-lineage-parent" aria-label={`Back to ${parent?.title ?? "parent thread"}`} disabled={!parent?.path} onClick={() => { if (parent?.path) void actions.switchSession(parent.path); }}>
      <CornerUpLeft aria-hidden /><span className="workspace-card-label">Back to {parent?.title ?? "parent thread"}</span>
    </button> : null}
    {rows(nativeRows)}
    {model.groups.map((group) => {
      const previousOpen = expanded.has(group.parentThreadId);
      const active = group.rows.filter((row) => (isBusyStatus(row.status) || row.status === "pending"));
      const previous = group.rows.filter((row) => !(isBusyStatus(row.status) || row.status === "pending"));
      return <div key={group.parentThreadId}>
        {model.groups.length > 1 ? <div className="agent-lineage-group">{group.parentTitle}</div> : null}
        {rows(active)}
        {previous.length ? <>
          <button type="button" className="workspace-card-row agent-lineage-toggle" aria-expanded={previousOpen} onClick={() => setExpanded((current) => { const next = new Set(current); if (previousOpen) next.delete(group.parentThreadId); else next.add(group.parentThreadId); return next; })}><span className="workspace-card-label">Completed{previousOpen ? "" : ` (${previous.length})`}</span><span className="workspace-card-tail">{previousOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}</span></button>
          {previousOpen ? rows(previous) : null}
        </> : null}
      </div>;
    })}
  </section>;
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
