import { useRef, useState } from "react";
import { useKeepClear } from "../reserved-region";
import type { UiContextUsage } from "../../shared/contracts";
import { tooltipProps } from "./ui/Tooltip";

export interface ContextBreakdown {
  messages: number;
  toolOutput: number;
  system: number;
}

function compact(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

const SEGMENTS: ReadonlyArray<{ key: keyof ContextBreakdown; label: string; color: string }> = [
  { key: "messages", label: "messages", color: "#8b8a7f" },
  { key: "toolOutput", label: "tool output", color: "#5d5d55" },
  { key: "system", label: "system & skills", color: "#3f3f38" },
];

/**
 * The dial shows real usage from the Pi session; the split across segments is a
 * chars/4 estimate over what the renderer holds, so it is labelled as one.
 */
export function ContextMeter({
  usage,
  breakdown,
  onCompact,
}: {
  usage: UiContextUsage;
  breakdown: ContextBreakdown;
  onCompact(): void;
}) {
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  // It hangs past the composer's right edge, which is where the dock begins.
  useKeepClear(popover, open);
  const percent = Math.min(100, Math.max(0, usage.percent));
  const free = Math.max(0, usage.contextWindow - usage.tokens);

  return (
    <span
      className="menu-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className="context-dial"
        style={{ ["--used" as string]: `${percent}%` }}
        {...tooltipProps(`Context ${Math.round(percent)}%`)}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Context ${Math.round(percent)} percent used`}
      >
        <i />
      </button>
      {open ? (
        <div className="context-popover" ref={popover}>
          <header>
            <strong>Context</strong>
            <span>{compact(usage.tokens)} / {compact(usage.contextWindow)}</span>
            <b>{Math.round(percent)}%</b>
          </header>
          <div className="context-bar">
            {SEGMENTS.map((segment) => (
              <span
                key={segment.key}
                style={{
                  width: `${(breakdown[segment.key] / usage.contextWindow) * 100}%`,
                  background: segment.color,
                }}
              />
            ))}
          </div>
          <div className="context-legend">
            {SEGMENTS.map((segment) => (
              <span key={segment.key}>
                <i style={{ background: segment.color }} />
                <em>{segment.label}</em>
                {compact(breakdown[segment.key])}
              </span>
            ))}
            <span>
              <i style={{ border: "1px solid #3f3f38" }} />
              <em>free</em>
              {compact(free)}
            </span>
          </div>
          <button onClick={onCompact}>Compact context</button>
          <small>auto-compacts at 85% · split is estimated</small>
        </div>
      ) : null}
    </span>
  );
}
