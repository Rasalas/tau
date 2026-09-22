import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArchiveRestore, Check, PlugZap } from "lucide-react";
import type { UiSession } from "../../shared/contracts";
import { ProviderIconStack } from "./ProviderIconStack";
import { threadCostLabel, threadUsageDetail } from "../cost-format";

export type ThreadActivity = "idle" | "ready" | "working" | "tool" | "settled" | "waiting" | "stalled" | "interrupted";

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
  onSelect(path: string): void;
  onToggleSettled(id: string): void;
}

function projectHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function projectInitial(name: string): string {
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
    <span className={`thread-status-age status-${activity}`} {...(hint ? { title: hint } : {})}>
      {working ? <i /> : null}
      {activity === "interrupted" ? <PlugZap size={11} aria-hidden="true" /> : null}
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
  onSelect,
  onToggleSettled,
}: ThreadRowProps) {
  const iconStyle = { "--project-hue": projectHue(session.projectPath) } as CSSProperties;
  const settled = activity === "settled";
  const projectMark = projectIcon
    ? <img src={projectIcon} alt="" aria-hidden="true" />
    : projectInitial(session.projectName);
  const label = activityLabel ?? (
    settled ? "Settled" : activity === "ready" ? "READY" : activity === "idle" ? "IDLE" : "WORKING"
  );
  const working = activity === "working" || activity === "tool";
  const showStatus = working || activity === "waiting" || activity === "ready" || activity === "interrupted";
  const childCount = workingChildren > 0
    ? (
      <span className="thread-agent-count" aria-label={`${workingChildren} agent${workingChildren === 1 ? "" : "s"} running`}>
        <i />{workingChildren} running
      </span>
    )
    : null;
  const cost = showCost ? threadCostLabel(session.usage) : undefined;

  if (settled || compact) {
    return (
      <article className={`thread-row compact ${active ? "active" : ""} activity-${activity}`}>
        <button className="thread-main" onClick={() => onSelect(session.path)}>
          <i className={`thread-project-icon ${projectIcon ? "has-image" : ""}`} style={iconStyle}>{projectMark}</i>
          <span className="thread-title">{session.title}</span>
          {childCount}
          {accessory}
          <time>{age}</time>
        </button>
        <button
          className="thread-settle"
          title={settled ? "Return thread to the rail" : "Settle thread"}
          aria-label={`${settled ? "Return" : "Settle"} ${session.title}`}
          onClick={() => onToggleSettled(session.id)}
        >
          {settled ? <ArchiveRestore size={14} /> : <Check size={15} />}
        </button>
      </article>
    );
  }

  return (
    <article className={`thread-row ${active ? "active" : ""} activity-${activity}`}>
      <button className="thread-main" onClick={() => onSelect(session.path)}>
        <span className="thread-project-line">
          <i className={`thread-project-icon ${projectIcon ? "has-image" : ""}`} style={iconStyle}>{projectMark}</i>
          <strong>{session.projectName}</strong>
          {showStatus
            ? <ThreadStatus activity={activity} label={working ? "WORKING" : label} {...(activityHint ? { hint: activityHint } : {})} startedAt={startedAt ?? session.modifiedAt} />
            : <time>{age}</time>}
        </span>
        <span className="thread-title">{session.title}</span>
        <span className="thread-meta-line">
          {childCount}
          {session.projectLabel ? <span className="thread-branch">{session.projectLabel}</span> : null}
          {accessory}
          {cost && session.usage ? <span className="thread-cost-meta" title={threadUsageDetail(session.usage)}>{cost}</span> : null}
          <ProviderIconStack modelProvider={modelProvider ?? session.modelProvider} runtimeProvider={session.backendKind} />
        </span>
      </button>
      <button
        className="thread-settle"
        title="Settle thread"
        aria-label={`Settle ${session.title}`}
        onClick={() => onToggleSettled(session.id)}
      >
        <Check size={15} />
      </button>
    </article>
  );
});
