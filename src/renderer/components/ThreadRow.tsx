import { memo, type CSSProperties } from "react";
import { ArchiveRestore, Check } from "lucide-react";
import type { UiSession } from "../../shared/contracts";

export type ThreadActivity = "idle" | "ready" | "working" | "tool" | "settled";

interface ThreadRowProps {
  activity: ThreadActivity;
  activityLabel?: string;
  active: boolean;
  age: string;
  compact?: boolean;
  session: UiSession;
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

export const ThreadRow = memo(function ThreadRow({
  activity,
  activityLabel,
  active,
  age,
  compact,
  session,
  onSelect,
  onToggleSettled,
}: ThreadRowProps) {
  const iconStyle = { "--project-hue": projectHue(session.projectPath) } as CSSProperties;
  const settled = activity === "settled";
  const label = activityLabel ?? (
    settled ? "Settled" : activity === "ready" ? "READY" : activity === "idle" ? "IDLE" : "WORKING"
  );

  if (settled || compact) {
    return (
      <article className={`thread-row compact ${active ? "active" : ""} activity-${activity}`}>
        <button className="thread-main" onClick={() => onSelect(session.path)}>
          <i className="thread-project-icon" style={iconStyle}>{projectInitial(session.projectName)}</i>
          <span className="thread-title">{session.title}</span>
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
          <i className="thread-project-icon" style={iconStyle}>{projectInitial(session.projectName)}</i>
          <strong>{session.projectName}</strong>
          <time>{age}</time>
        </span>
        <span className="thread-title">{session.title}</span>
        <span className="thread-meta-line">
          <span className="thread-branch">{session.branch ?? "no branch"}</span>
          <span className="thread-activity"><i />{label}</span>
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
