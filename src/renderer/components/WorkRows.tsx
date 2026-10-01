import { ChevronRight, CircleAlert, Clock, Hammer } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { UiToolOutputPreview, UiToolRun, UiTurnActivityEntry } from "../../shared/contracts";
import {
  deriveWorkRows,
  formatLiveClock,
  toolActionClass,
  waitingActivityLabel,
  type TranscriptDetail,
  type WorkRow,
} from "../../workbench/transcript-folding";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";
import { LazyFeatureBoundary } from "./LazyFeature";
import { ToolRun } from "./ToolRun";
import { useDisclosure, type WorkDisclosures } from "./work-disclosures";

/**
 * The clock over a running turn. It writes its own text node every second, so
 * a turn that runs for minutes costs no React commit for the ticking.
 */
export function WorkingTimer({ startedAt }: { startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      if (ref.current) ref.current.textContent = formatLiveClock(Date.now() - startedAt);
    };
    write();
    const timer = window.setInterval(write, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="work-live-clock" ref={ref}>{formatLiveClock(Date.now() - startedAt)}</span>;
}

export interface WorkRowActions {
  registry: ExtensionRegistry;
  actions?: WorkbenchActions;
  detail: TranscriptDetail;
  /** The thread's open and closed rows, so a row the list remounts keeps the reader's choice. */
  disclosures?: WorkDisclosures;
  /** The turn's first call, which names the turn in `disclosures`. */
  turn?: string;
  waiting?: boolean;
  /** What the turn waits for while `waiting`: leave to use a tool, or an answer. */
  waitingFor?: "approval" | "question";
  stalled?: boolean;
  onRecover?(): void;
  onStop?(): void;
  onCopyOutput?(tool: UiToolRun): Promise<void> | void;
  onLoadOutput?(tool: UiToolRun): Promise<UiToolOutputPreview | undefined>;
}

function toolRun(tool: UiToolRun, context: WorkRowActions) {
  return <ToolRun
    key={tool.id}
    tool={tool}
    registry={context.registry}
    detail={context.detail}
    waiting={tool.status === "running" && Boolean(context.waiting)}
    stalled={tool.status === "running" && Boolean(context.stalled)}
    onStop={context.stalled ? context.onRecover : context.onStop}
    onCopyOutput={context.onCopyOutput}
    onLoadOutput={context.onLoadOutput}
  />;
}

const settledRead = (tool: UiToolRun) => tool.status === "done" && toolActionClass(tool.name) === "read";

/** Files read one after another, as one row: "Read a.ts, b.ts · 2 files" (design 1f). */
function ReadBundle({ tools, context }: { tools: readonly UiToolRun[]; context: WorkRowActions }) {
  const [open, setOpen] = useDisclosure(context.disclosures, `read:${tools[0].id}`, false, context.turn);
  const views = tools.map((tool) => context.registry.presentTool(tool));
  const paths = views.map((view) => view.file ?? view.detail);
  return <div className={`tool-run tone-${views[0].tone}`}>
    <button type="button" className="tool-run-line" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="tool-run-glyph">{views[0].glyph}</span>
      <span className="tool-run-name">{views[0].title}</span>
      <span className="tool-run-detail" title={paths.join("\n")}>{paths.map((path) => path.split("/").pop()).join(", ")}</span>
      <span className="tool-run-state">{tools.length} files</span>
    </button>
    {open ? tools.map((tool) => toolRun(tool, context)) : null}
  </div>;
}

/** Calls as the rows of one card; consecutive reads share a row. */
function ToolRunList({ tools, context, label }: { tools: readonly UiToolRun[]; context: WorkRowActions; label?: string }) {
  const rows = [];
  for (let at = 0; at < tools.length;) {
    let end = at;
    while (end < tools.length && settledRead(tools[end])) end += 1;
    if (end - at > 1) rows.push(<ReadBundle key={tools[at].id} tools={tools.slice(at, end)} context={context} />);
    else { end = at + 1; rows.push(toolRun(tools[at], context)); }
    at = end;
  }
  return <div className="tool-activity-detail" role="group" aria-label={label}>{rows}</div>;
}

/** A settled run of tools as one card, a row per call: one fold level, not three (design 1f). */
function GroupRow({ row, context }: { row: Extract<WorkRow, { kind: "group" }>; context: WorkRowActions }) {
  return <ToolRunList tools={row.tools} context={context} label={row.summary} />;
}

/** "Worked for 2m 14s": the whole turn, one muted line, expanding in place. */
function FoldRow({ row, context }: { row: Extract<WorkRow, { kind: "fold" }>; context: WorkRowActions }) {
  const [open, setOpen] = useDisclosure(context.disclosures, row.id, row.open, context.turn);
  return <section className={`work-fold${open ? " expanded" : ""}`}>
    <button type="button" className="work-fold-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Clock size={13} strokeWidth={1.7} aria-hidden="true" />
      <span>{row.label}</span>
      {row.failed ? (
        <span className="tool-activity-status-icon error" role="img" aria-label="Turn failed" title="Turn failed">
          <CircleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : null}
      <ChevronRight className="activity-chevron" size={13} />
    </button>
    {open ? <div className="work-fold-body">
      {row.rows.map((nested) => <WorkRowView key={nested.id} row={nested} context={context} />)}
    </div> : null}
  </section>;
}

/**
 * The one line a running turn shows. Its key never changes while the turn
 * runs, so the row morphs in place instead of remounting per tool call.
 */
function LiveRow({ row, context }: { row: Extract<WorkRow, { kind: "live" }>; context: WorkRowActions }) {
  const [open, setOpen] = useDisclosure(context.disclosures, row.id, false, context.turn);
  // Waiting on the person reads as the design's quiet line: a spinner and what is asked, no clock.
  if (context.waiting) {
    return <section className={`work-live waiting${open ? " expanded" : ""}`}>
      <button type="button" className="work-live-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="spinner tone-current small" aria-hidden="true" />
        <span className="work-live-label">{waitingActivityLabel(row.action, context.waitingFor ?? "question")}</span>
        <ChevronRight className="activity-chevron" size={13} />
      </button>
      {open ? <ToolRunList tools={row.tools} context={context} /> : null}
    </section>;
  }
  // A live row always shimmers, also between tools: the turn is still working on it.
  return <section className={`work-live running${open ? " expanded" : ""}`}>
    <button type="button" className="work-live-line" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Hammer size={15} strokeWidth={1.7} />
      <span className="work-live-label">{row.label}</span>
      <WorkingTimer startedAt={row.startedAt} />
      <ChevronRight className="activity-chevron" size={13} />
    </button>
    {open ? <ToolRunList tools={row.tools} context={context} /> : null}
  </section>;
}

function CardRow({ row, context }: { row: Extract<WorkRow, { kind: "card" }>; context: WorkRowActions }) {
  const card = context.registry.toolCard(row.cardId);
  if (!card || !context.actions) return null;
  return <LazyFeatureBoundary label={card.id}>
    <card.Component tools={row.tools} actions={context.actions} />
  </LazyFeatureBoundary>;
}

function WorkRowView({ row, context }: { row: WorkRow; context: WorkRowActions }) {
  switch (row.kind) {
    case "fold": return <FoldRow row={row} context={context} />;
    case "live": return <LiveRow row={row} context={context} />;
    case "card": return <CardRow row={row} context={context} />;
    default: return <GroupRow row={row} context={context} />;
  }
}

export interface WorkGroupProps extends Omit<WorkRowActions, "stalled"> {
  /** The turn activity entry this group belongs to; every row key derives from it. */
  id: string;
  tools: readonly UiToolRun[];
  status?: UiTurnActivityEntry["status"];
  /** Whether a run is actually in flight for this thread. */
  streaming?: boolean;
  /** When the turn's answer arrived, so a trailing tool can be told from new work. */
  answerAt?: number;
}

/**
 * One turn's work. The rows come from `deriveWorkRows`, so what this component
 * owns is only what a reader toggled — never a rule about what to show.
 */
export const WorkGroup = memo(function WorkGroup({
  id,
  tools,
  status = "completed",
  streaming,
  answerAt,
  registry,
  actions,
  detail,
  disclosures,
  waiting,
  waitingFor,
  onRecover,
  onStop,
  onCopyOutput,
  onLoadOutput,
}: WorkGroupProps) {
  // Only claim interruption when the caller actually knows no run is in flight
  // and a call is still open; an unknown streaming state must not turn live
  // tools into "interrupted", and a settled turn is not an interrupted one.
  const stalled = streaming === false && !waiting && tools.some((tool) => tool.status === "running");
  const turn = tools[0]?.id;
  const registryVersion = registry.getVersion();
  const rows = useMemo(() => deriveWorkRows({
    // Read when the turn settles: what the reader opened while it ran stays in view.
    keepOpen: turn !== undefined && disclosures?.openedInTurn(turn) === true,
    id,
    tools,
    status: stalled ? "interrupted" : status,
    detail,
    now: Date.now(),
    ...(answerAt === undefined ? {} : { answerAt }),
    ...(streaming === undefined ? {} : { streaming }),
    cardIdFor: (tool) => registry.toolCardFor(tool)?.id,
    presentationOf: (tool) => {
      const view = registry.presentTool(tool);
      return { title: view.title, detail: view.detail, ...(view.source ? { source: view.source } : {}) };
    },
  // The registry's version is what makes a newly registered renderer or card
  // reach a group that is already on screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [answerAt, detail, disclosures, id, registry, turn, registryVersion, stalled, status, streaming, tools]);
  if (rows.length === 0) return null;

  const context: WorkRowActions = {
    registry,
    detail,
    stalled,
    ...(disclosures ? { disclosures } : {}),
    ...(turn === undefined ? {} : { turn }),
    ...(actions ? { actions } : {}),
    ...(waiting === undefined ? {} : { waiting }),
    ...(waitingFor === undefined ? {} : { waitingFor }),
    ...(onRecover ? { onRecover } : {}),
    ...(onStop ? { onStop } : {}),
    ...(onCopyOutput ? { onCopyOutput } : {}),
    ...(onLoadOutput ? { onLoadOutput } : {}),
  };
  return <>{rows.map((row) => <WorkRowView key={row.id} row={row} context={context} />)}</>;
});
