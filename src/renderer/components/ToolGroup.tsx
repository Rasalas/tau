import { ChevronRight, Hammer, Square } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { UiToolRun } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { ACTIVE_TOOL_OUTPUT_LIMIT, SETTLED_TOOL_OUTPUT_LIMIT, boundToolOutput } from "../tool-output";

function seconds(from: number, to: number): string {
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

const ToolRun = memo(function ToolRun({
  tool,
  registry,
  waiting,
  stalled,
  onStop,
}: {
  tool: UiToolRun;
  registry: ExtensionRegistry;
  /** This tool is what the open question belongs to. */
  waiting?: boolean;
  /** Marked running, but no run is in flight — the turn that issued it is gone. */
  stalled?: boolean;
  /** Stops a live tool's run, or closes a stalled call so the thread works again. */
  onStop?(): void;
}) {
  const running = tool.status === "running" && !stalled;
  // A running tool shows its live tail without needing a click.
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const view = registry.presentTool(tool);
  const bounded = boundToolOutput(tool.output, running ? ACTIVE_TOOL_OUTPUT_LIMIT : SETTLED_TOOL_OUTPUT_LIMIT);
  const liveLines = running ? bounded.text.split("\n") : [];
  const liveOutputClipped = running && liveLines.length > 5;
  const visibleOutput = liveOutputClipped ? liveLines.slice(-5).join("\n") : bounded.text;
  const showOutput = view.output !== "hidden" && Boolean(visibleOutput) && (running ? !collapsed : collapsed);
  const copyFullOutput = () => {
    if (tool.output) void navigator.clipboard?.writeText(tool.output);
  };
  // A call that is still open — live, waiting on you, or left behind by a dead
  // turn — offers one way out, on hover, right where it sits.
  const stoppable = tool.status === "running" && Boolean(onStop);
  const stopTitle = stalled ? "Close the interrupted call" : waiting ? "Stop waiting and end the run" : "Stop the run";

  return (
    <div className={`tool-run tone-${view.tone}${running ? " running" : ""}${stoppable ? " stoppable" : ""}`}>
      <button className="tool-run-line" onClick={() => setCollapsed((value) => !value)}>
        <span className="tool-run-glyph">{view.glyph}</span>
        <span className="tool-run-name">{view.title}</span>
        <span className="tool-run-detail" title={view.detail}>{view.detail}</span>
        <span className={`tool-run-state ${stalled ? "stalled" : tool.status}${waiting ? " waiting" : ""}`}>
          {waiting
            ? "waiting for you"
            : stalled
              ? "interrupted"
              : running
                ? seconds(tool.startedAt, now)
                : tool.status === "error"
                  ? "!"
                  : tool.endedAt ? seconds(tool.startedAt, tool.endedAt) : "✓"}
        </span>
      </button>
      {stoppable ? (
        <button
          type="button"
          className="tool-run-stop"
          title={stopTitle}
          aria-label={stopTitle}
          onClick={(event) => { event.stopPropagation(); onStop?.(); }}
        >
          <Square size={10} strokeWidth={2.4} />
        </button>
      ) : null}
      {showOutput ? (
        <pre className="tool-output">
          {bounded.truncated || liveOutputClipped ? (
            <button className="tool-output-truncated" onClick={(event) => { event.stopPropagation(); copyFullOutput(); }}>
              … earlier output hidden · copy full output
            </button>
          ) : null}
          {visibleOutput}
        </pre>
      ) : null}
    </div>
  );
});

export const TOOL_PREVIEW_MIN_MS = 3_000;

function useToolPreview(tools: UiToolRun[], keepLatest: boolean): UiToolRun | undefined {
  const newestRunning = [...tools].reverse().find((tool) => tool.status === "running");
  const initialPreview = newestRunning ?? (keepLatest ? tools.at(-1) : undefined);
  const [previewId, setPreviewId] = useState<string | undefined>(initialPreview?.id);
  const previewIdRef = useRef(previewId);
  const shownAtRef = useRef(Date.now());
  previewIdRef.current = previewId;

  useEffect(() => {
    const currentId = previewIdRef.current;
    const nextRunning = [...tools].reverse().find((tool) => tool.status === "running");
    const nextCandidate = nextRunning ?? (keepLatest ? tools.at(-1) : undefined);
    const replace = (id?: string) => {
      previewIdRef.current = id;
      shownAtRef.current = Date.now();
      setPreviewId(id);
    };
    if (!currentId) {
      if (nextCandidate) replace(nextCandidate.id);
      return;
    }

    const currentRunning = tools.some((tool) => tool.id === currentId && tool.status === "running");
    const successor = nextCandidate?.id !== currentId ? nextCandidate : undefined;
    if (!successor && currentRunning) return;

    const remaining = TOOL_PREVIEW_MIN_MS - (Date.now() - shownAtRef.current);
    if (remaining <= 0) {
      replace(successor?.id);
      return;
    }
    const timer = window.setTimeout(() => replace(successor?.id), remaining);
    return () => window.clearTimeout(timer);
  }, [keepLatest, tools]);

  return previewId ? tools.find((tool) => tool.id === previewId) : undefined;
}

function activitySummary(tools: UiToolRun[], live: number): string {
  const commands = tools.filter((tool) => tool.name === "bash" || tool.name === "powershell").length;
  const otherTools = tools.length - commands;
  const toolLabel = `${otherTools} ${otherTools === 1 ? "tool" : "tools"}`;
  const commandLabel = `${commands} ${commands === 1 ? "command" : "commands"}`;
  if (live > 0) {
    const counts = commands > 0 && otherTools > 0
      ? `${toolLabel} and ${commandLabel}`
      : commands > 0 ? commandLabel : toolLabel;
    return `Using ${counts} · ${live} running`;
  }
  if (commands > 0 && otherTools > 0) return `Used ${toolLabel} and ran ${commandLabel}`;
  if (commands > 0) return `Ran ${commandLabel}`;
  return `Used ${toolLabel}`;
}

export function ToolGroup({
  tools,
  registry,
  streaming,
  waiting,
  onRecover,
  onStop,
}: {
  tools: UiToolRun[];
  registry: ExtensionRegistry;
  /** Whether a run is actually in flight for this thread. */
  streaming?: boolean;
  /** This thread has an open question, so its running tool is waiting on you. */
  waiting?: boolean;
  /** Closes tool calls left dangling by a turn that died, so the thread works again. */
  onRecover?(): void;
  /** Stops the run this thread has in flight. */
  onStop?(): void;
}) {
  // Only claim interruption when the caller actually knows no run is in flight;
  // an unknown streaming state must not turn live tools into "interrupted".
  const stalled = streaming === false && !waiting;
  const live = tools.filter((tool) => tool.status === "running").length;
  const previewTool = useToolPreview(tools, Boolean(streaming));
  const previewToolId = previewTool?.id;
  const [expanded, setExpanded] = useState(Boolean(previewTool));
  useEffect(() => setExpanded(Boolean(previewToolId) || live > 0), [live, previewToolId]);
  if (tools.length === 0) return null;
  const activity = activitySummary(tools, live);
  const summary = waiting && live > 0
    ? "Waiting for your answer"
    : stalled && live > 0
      ? `${live} tool ${live === 1 ? "call" : "calls"} interrupted`
      : streaming
        ? `Working · ${activity.replace(/^Using /u, "")}`
        : activity;
  const visibleTools = previewTool
    ? [previewTool]
    : live > 0
      ? tools.filter((tool) => tool.status === "running").slice(-1)
      : tools;

  return (
    <section className={`tool-activity${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {(live > 0 || streaming) && !stalled ? <span className="spinner acid small" /> : <Hammer size={16} strokeWidth={1.7} />}
        <span>{summary}</span>
        <ChevronRight className="activity-chevron" size={14} />
      </button>
      {expanded ? (
        <div className="tool-activity-detail">
          {visibleTools.map((tool) => (
            <ToolRun
              key={tool.id}
              tool={tool}
              registry={registry}
              waiting={tool.status === "running" && Boolean(waiting)}
              stalled={tool.status === "running" && stalled}
              onStop={stalled ? onRecover : onStop}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
