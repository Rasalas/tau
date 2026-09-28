import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArchiveRestore, Check, CircleAlert, Hourglass, PlugZap } from "lucide-react";
import type { UiSession } from "../../shared/contracts";
import { ProviderIconStack } from "./ProviderIconStack";
import { threadCostLabel, threadCostOrigin } from "../cost-format";
import { DEFAULT_RUNTIME, threadOnPlan } from "../runtime-marks";
import { MiddleTruncate } from "./ui/MiddleTruncate";
import { tooltipProps } from "./ui/Tooltip";

export type ThreadActivity = "idle" | "ready" | "working" | "tool" | "settled" | "waiting" | "stalled" | "interrupted" | "failed" | "limited";

export interface ThreadRowMachine {
  name: string;
  icon: ReactNode;
}

function MachineMark({ machine }: { machine: ThreadRowMachine }) {
  return <span className="thread-machine" role="img" aria-label={`On ${machine.name}`} {...tooltipProps(machine.name)}>{machine.icon}</span>;
}

interface ThreadRowProps {
  activity: ThreadActivity;
  activityLabel?: string;
  /** Tooltip for the activity badge; what the state means, in the caller's words. */
  activityHint?: string;
  active: boolean;
  age: string;
  compact?: boolean;
  /** Threads spawned from this one that are working right now. */
  workingChildren?: number;
  projectIcon?: string;
  modelProvider?: string;
  session: UiSession;
  /** Off when the user hid costs; the meta line stays as it was. */
  showCost?: boolean;
  startedAt?: number;
  /** A kit's own marks for this thread (a request status, say), drawn beside the branch. */
  accessory?: ReactNode;
  /** The machine a thread of another machine runs on: its icon just before the cost, its name as tooltip. */
  machine?: ThreadRowMachine;
  /** Buttons drawn beside Settle while the row is hovered or focused (a snooze clock, say). */
  actions?: ReactNode;
  /** Off when the project label says nothing new, e.g. the repository's default branch. */
  showLabel?: boolean;
  /** A few lines about the thread, shown beside the row on hover in place of the title's own tooltip. */
  details?: string;
  onSelect(path: string): void;
  /** Absent for a thread this rail cannot settle (another machine's): the row has no Settle button. */
  onToggleSettled?(id: string): void;
}

export function projectHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "·";
}

function elapsedLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function ThreadStatus({ activity, label, hint, startedAt }: { activity: ThreadActivity; label: string; hint?: string; startedAt: number }) {
  const working = activity === "working" || activity === "tool";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working]);
  return (
    <span className={`thread-status-age status-${activity}`} {...tooltipProps(hint)}>
      {working ? <i /> : null}
      {activity === "interrupted" ? <PlugZap size={11} aria-hidden="true" /> : null}
      {activity === "failed" ? <CircleAlert size={11} aria-hidden="true" /> : null}
      {activity === "limited" ? <Hourglass size={11} aria-hidden="true" /> : null}
      {label}
      {working ? <time>{elapsedLabel(now - startedAt)}</time> : null}
    </span>
  );
}

export const ThreadRow = memo(function ThreadRow({
  activity,
  activityLabel,
  activityHint,
  active,
  age,
  compact,
  workingChildren = 0,
  projectIcon,
  modelProvider,
  session,
  showCost,
  startedAt,
  accessory,
  machine,
  actions,
  showLabel = true,
  details,
  onSelect,
  onToggleSettled,
}: ThreadRowProps) {
  const iconStyle = { "--project-hue": projectHue(session.projectPath) } as CSSProperties;
  const settled = activity === "settled";
  const projectMark = projectIcon
    ? <img src={projectIcon} alt="" aria-hidden="true" />
    : projectInitial(session.projectName);
  const label = activityLabel ?? (
    settled ? "Settled" : activity === "ready" ? "Ready" : activity === "idle" ? "Idle" : "Working"
  );
  const working = activity === "working" || activity === "tool";
  const showStatus = working || activity === "waiting" || activity === "ready" || activity === "interrupted" || activity === "failed" || activity === "limited";
  const childCount = workingChildren > 0
    ? (
      <span className="thread-agent-count" aria-label={`${workingChildren} agent${workingChildren === 1 ? "" : "s"} running`}>
        <i />{workingChildren} running
      </span>
    )
    : null;
  const cost = showCost ? threadCostLabel(session.usage) : undefined;
  const hover = details ? tooltipProps(details, { side: "right", variant: "lines" }) : undefined;
  const titleTip = hover ? undefined : tooltipProps(session.title, { when: "truncated", side: "right" });

  if (settled || compact) {
    return (
      <article className={`thread-row compact ${active ? "active" : ""} activity-${activity}`}>
        <button className="thread-main" onClick={() => onSelect(session.path)} {...hover}>
          <i className={`thread-project-icon ${projectIcon ? "has-image" : ""}`} style={iconStyle}>{projectMark}</i>
          <span className="thread-title" {...titleTip}>{session.title}</span>
          {childCount}
          {accessory}
          {machine ? <MachineMark machine={machine} /> : null}
          <time>{age}</time>
        </button>
        {onToggleSettled || (!settled && actions) ? <span className="thread-row-actions">
          {settled ? null : actions}
          {onToggleSettled ? <button
            className="thread-settle"
            {...tooltipProps(settled ? "Return thread to the rail" : "Settle thread")}
            aria-label={`${settled ? "Return" : "Settle"} ${session.title}`}
            onClick={() => onToggleSettled(session.id)}
          >
            {settled ? <ArchiveRestore size={13} /> : <Check size={13} />}
          </button> : null}
        </span> : null}
      </article>
    );
  }

  return (
    <article className={`thread-row ${active ? "active" : ""} activity-${activity}`}>
      <button className="thread-main" onClick={() => onSelect(session.path)} {...hover}>
        <span className="thread-project-line">
          <i className={`thread-project-icon ${projectIcon ? "has-image" : ""}`} style={iconStyle}>{projectMark}</i>
          <strong>{session.projectName}</strong>
          {showStatus
            ? <ThreadStatus activity={activity} label={working ? "Working" : label} {...(activityHint ? { hint: activityHint } : {})} startedAt={startedAt ?? session.modifiedAt} />
            : <time>{age}</time>}
        </span>
        <span className="thread-title" {...titleTip}>{session.title}</span>
        {/* Drawn right to left, so what comes first here stays longest when the card is narrow (see styles.css). */}
        <span className="thread-meta-line">
          <span className="thread-meta-end">
            {machine ? <MachineMark machine={machine} /> : null}
            {cost && session.usage ? <span className="thread-cost-meta" {...tooltipProps(threadCostOrigin(session.usage))}>{cost}</span> : null}
            <ProviderIconStack modelProvider={modelProvider ?? session.modelProvider} runtimeProvider={session.backendKind ?? DEFAULT_RUNTIME} plan={threadOnPlan(session.usage)} />
          </span>
          {accessory ? <span className="thread-meta-marks">{accessory}</span> : null}
          {showLabel && session.projectLabel ? <MiddleTruncate className="thread-branch" value={session.projectLabel} /> : null}
          {childCount}
        </span>
      </button>
      {actions || onToggleSettled ? <span className="thread-row-actions">
        {actions}
        {onToggleSettled ? <button
          className="thread-settle"
          {...tooltipProps("Settle thread")}
          aria-label={`Settle ${session.title}`}
          onClick={() => onToggleSettled(session.id)}
        >
          <Check size={13} /><span>Settle</span>
        </button> : null}
      </span> : null}
    </article>
  );
});
