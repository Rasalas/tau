import { Bell, CalendarClock, ChevronRight, GitPullRequest, SquareTerminal, Target } from "lucide-react";
import { useState } from "react";
import type { UiWake } from "../../shared/contracts";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

export function WakeIcon({ source, size = 14 }: { source: string; size?: number }) {
  const Icon = source === "pull-request" ? GitPullRequest : source === "goal" ? Target : source === "automation" ? CalendarClock : source === "background" ? SquareTerminal : Bell;
  return <Icon className="wake-icon" size={size} strokeWidth={1.8} aria-hidden="true" />;
}

/**
 * Something other than the user started this turn: a centred line between
 * hairlines with its source, what happened and when. What the agent was told
 * opens under it.
 */
export function WakeLine({ wake, detail, timestamp }: { wake: UiWake; detail: string; timestamp: number }) {
  const [open, setOpen] = useState(false);
  const body = detail.trim();
  const time = <time dateTime={new Date(timestamp).toISOString()} title={fullTimestamp(timestamp)}>{compactTimestamp(timestamp)}</time>;
  return <div className={`wake-line source-${wake.source}`} role="note" aria-label={wake.label}>
    <div className="wake-line-row">
      {body ? <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <WakeIcon source={wake.source} />
        <span>{wake.label}</span>
        {time}
        <ChevronRight className="wake-chevron" size={12} aria-hidden="true" />
      </button> : <span className="wake-line-label"><WakeIcon source={wake.source} /><span>{wake.label}</span>{time}</span>}
    </div>
    {open ? <pre className="wake-line-detail">{body}</pre> : null}
  </div>;
}
