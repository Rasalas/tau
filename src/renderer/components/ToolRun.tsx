import { Square } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { UiToolOutputPreview, UiToolRun } from "../../shared/contracts";
import { toolFailureReason, type TranscriptDetail } from "../../workbench/transcript-folding";
import type { ExtensionRegistry } from "../extension-system";
import { ACTIVE_TOOL_OUTPUT_LIMIT, SETTLED_TOOL_OUTPUT_LIMIT, boundToolOutput } from "../tool-output";
import { formatBytes } from "../format-bytes";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

function seconds(from: number, to: number): string {
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

/** One tool call: what it was, how long it took, and — on request — what it said. */
export const ToolRun = memo(function ToolRun({
  tool,
  registry,
  detail = "focused",
  waiting,
  stalled,
  onStop,
  onCopyOutput,
  onLoadOutput,
}: {
  tool: UiToolRun;
  registry: ExtensionRegistry;
  /** `everything` prints the whole result and stamps the call with its time. */
  detail?: TranscriptDetail;
  /** This tool is what the open question belongs to. */
  waiting?: boolean;
  /** Marked running, but no run is in flight — the turn that issued it is gone. */
  stalled?: boolean;
  /** Stops a live tool's run, or closes a stalled call so the thread works again. */
  onStop?(): void;
  /** Reads the unbounded result through the host when a preview is clipped. */
  onCopyOutput?(tool: UiToolRun): Promise<void> | void;
  /** Loads the output the host held back (`outputDeferred`) when the row opens. */
  onLoadOutput?(tool: UiToolRun): Promise<UiToolOutputPreview | undefined>;
}) {
  const running = tool.status === "running" && !stalled;
  // A running tool shows its live tail without needing a click. Settled output
  // is deliberately hidden until the row itself is opened.
  const [outputOpen, setOutputOpen] = useState(running);
  useEffect(() => {
    setOutputOpen(running);
  }, [running]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const view = registry.presentTool(tool);
  const deferred = tool.outputDeferred === true && tool.output === undefined;
  const loaded = useDeferredOutput(deferred && outputOpen ? tool : undefined, onLoadOutput);
  const shown = deferred && typeof loaded === "object"
    ? {
      ...tool,
      output: loaded.output,
      ...(loaded.outputTruncated ? { outputTruncated: true } : {}),
      ...(loaded.fullOutputAvailable ? { fullOutputAvailable: true } : {}),
    }
    : tool;
  const complete = detail === "everything";
  const bounded = complete
    ? { text: shown.output ?? "", truncated: false }
    : boundToolOutput(shown.output, running ? ACTIVE_TOOL_OUTPUT_LIMIT : SETTLED_TOOL_OUTPUT_LIMIT);
  const liveLines = running && !complete ? bounded.text.split("\n") : [];
  const liveOutputClipped = running && liveLines.length > 5;
  const visibleOutput = liveOutputClipped ? liveLines.slice(-5).join("\n") : bounded.text;
  const outputNeedsFullRead = shown.fullOutputAvailable === true
    || shown.outputTruncated === true
    || bounded.truncated
    || liveOutputClipped;
  const pending = deferred && typeof loaded !== "object";
  const showOutput = view.output !== "hidden" && (Boolean(visibleOutput) || deferred) && outputOpen;
  const size = deferred && tool.outputLength !== undefined ? formatBytes(tool.outputLength) : undefined;
  const [copying, setCopying] = useState(false);
  const copyFullOutput = async () => {
    if (copying) return;
    setCopying(true);
    try {
      // A preview is never a safe fallback: only the host seam can retrieve
      // the persisted result behind this deliberate action.
      if (onCopyOutput) await onCopyOutput(shown);
    } finally {
      setCopying(false);
    }
  };
  // A call that is still open — live, waiting on you, or left behind by a dead
  // turn — offers one way out, on hover, right where it sits.
  const stoppable = tool.status === "running" && Boolean(onStop);
  const failure = tool.status === "error" ? toolFailureReason(shown.output) ?? (deferred ? "Failed; open the call for its output" : "Failed") : undefined;
  const stopTitle = stalled ? "Close the interrupted call" : waiting ? "Stop waiting and end the run" : "Stop the run";

  return (
    <div className={`tool-run tone-${view.tone}${running ? " running" : ""}${stoppable ? " stoppable" : ""}`}>
      <button
        type="button"
        className="tool-run-line"
        aria-expanded={showOutput}
        onClick={() => setOutputOpen((value) => !value)}
      >
        <span className="tool-run-glyph">{view.glyph}</span>
        <span className="tool-run-name">{view.title}</span>
        <span className="tool-run-detail" title={view.detail}>{view.detail}</span>
        {size ? <span className="tool-run-size" title="Output size; it loads when the row opens">{size}</span> : null}
        {complete ? (
          <time className="tool-run-stamp" dateTime={new Date(tool.startedAt).toISOString()} title={fullTimestamp(tool.startedAt)}>
            {compactTimestamp(tool.startedAt)}
          </time>
        ) : null}
        <span
          className={`tool-run-state ${stalled ? "stalled" : tool.status}${waiting ? " waiting" : ""}`}
          {...(failure ? { role: "img", "aria-label": `Failed: ${failure}`, title: failure } : {})}
        >
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
      {failure && !showOutput ? <div className="tool-run-reason" title={failure}>{failure}</div> : null}
      {showOutput && pending ? (
        // As tall as the output it stands for, which always fills the box, so nothing moves when it arrives.
        <pre className="tool-output tool-output-pending" aria-busy={loaded === "loading"}>
          {loaded === "failed" ? "The output could not be loaded." : `Loading ${size ?? "the"} output…`}
        </pre>
      ) : showOutput ? (
        <pre className="tool-output">
          {outputNeedsFullRead ? (
            <button type="button" className="tool-output-truncated" onClick={(event) => { event.stopPropagation(); void copyFullOutput(); }}>
              {copying ? "… loading full output" : "… earlier output hidden · copy full output"}
            </button>
          ) : null}
          {visibleOutput}
        </pre>
      ) : null}
    </div>
  );
});

type DeferredOutput = UiToolOutputPreview | "loading" | "failed" | undefined;

/**
 * Loads a deferred tool's output the first time its row opens; `tool` is
 * undefined while the row is closed. What loaded stays for the next opening.
 */
function useDeferredOutput(
  tool: UiToolRun | undefined,
  load: ((tool: UiToolRun) => Promise<UiToolOutputPreview | undefined>) | undefined,
): DeferredOutput {
  const [loaded, setLoaded] = useState<{ id: string; value: Exclude<DeferredOutput, undefined> }>();
  const id = tool?.id;
  const current = tool && !load ? "failed" : loaded?.id === id ? loaded?.value : undefined;
  useEffect(() => {
    if (!tool || !load || current === "loading" || typeof current === "object") return;
    const settle = (value: Exclude<DeferredOutput, undefined>) =>
      setLoaded((previous) => previous?.id === tool.id ? { id: tool.id, value } : previous);
    setLoaded({ id: tool.id, value: "loading" });
    load(tool).then((result) => settle(result ?? "failed"), () => settle("failed"));
  // Once per opening of a tool; a new object for the same tool must not load it again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, load]);
  return current;
}
