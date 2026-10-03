import { FileSymlink, Square } from "lucide-react";
import { memo, useContext, useEffect, useState } from "react";
import type { UiToolOutputPreview, UiToolRun } from "../../shared/contracts";
import { exitCode, formatWorkDuration, toolActionClass, toolFailureReason, type TranscriptDetail } from "../../workbench/transcript-folding";
import type { ExtensionRegistry } from "../extension-system";
import { ACTIVE_TOOL_OUTPUT_LIMIT, SETTLED_TOOL_OUTPUT_LIMIT, boundToolOutput } from "../tool-output";
import { formatBytes } from "../format-bytes";
import { WorkbenchContext } from "../workbench-context";
import { compactTimestamp, fullTimestamp } from "./message-timestamp";

function seconds(from: number, to: number): string {
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

/** How long a settled call took: tenths under ten seconds, as in "exit 1 · 2.3s". */
function took(ms: number): string {
  return ms < 10_000 ? `${(Math.max(ms, 100) / 1000).toFixed(1)}s` : formatWorkDuration(ms);
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
  const failed = tool.status === "error";
  const view = registry.presentTool(tool);
  // Rich previews such as edit diffs follow transcript detail. Plain output
  // opens for running tools and failed commands; settled results need a click.
  const openByDefault = view.body
    ? detail !== "focused"
    : running || (failed && toolActionClass(tool.name) === "command");
  const [outputOpen, setOutputOpen] = useState(openByDefault);
  useEffect(() => {
    setOutputOpen(openByDefault);
  }, [openByDefault]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
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
  const showOutput = view.output !== "hidden" && !view.body && (Boolean(visibleOutput) || deferred) && outputOpen;
  const showBody = Boolean(view.body) && outputOpen;
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
  const openFile = useContext(WorkbenchContext)?.openFile;
  // A settled call that names its file links to it; the stop button has the place while it runs.
  const linked = !stoppable && view.file && openFile ? view.file : undefined;
  const failure = failed ? toolFailureReason(shown.output) ?? (deferred ? "Failed; open the call for its output" : "Failed") : undefined;
  const stopTitle = stalled ? "Close the interrupted call" : waiting ? "Stop waiting and end the run" : "Stop the run";

  return (
    <div className={`tool-run tone-${view.tone}${running ? " running" : ""}${failed ? " failed" : ""}${stoppable || linked ? " stoppable" : ""}`}>
      <button
        type="button"
        className="tool-run-line"
        aria-expanded={showOutput || showBody}
        onClick={() => setOutputOpen((value) => !value)}
      >
        <span className="tool-run-glyph">{view.glyph}</span>
        <span className="tool-run-name">{view.title}</span>
        <span className="tool-run-detail" title={view.detail}>{view.detail}</span>
        {size ? <span className="tool-run-size" title="Output size; it loads when the row opens">{size}</span> : null}
        {view.note}
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
                : [failed && (exitCode(shown.output) ? `exit ${exitCode(shown.output)}` : "failed"), tool.endedAt && took(tool.endedAt - tool.startedAt)]
                  .filter(Boolean).join(" · ") || "✓"}
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
      {linked ? (
        <button type="button" className="tool-run-stop" title={`Open ${linked}`} aria-label={`Open ${linked}`} onClick={() => openFile?.(linked)}>
          <FileSymlink size={12} />
        </button>
      ) : null}
      {failure && !showOutput ? <div className="tool-run-reason" title={failure}>{failure}</div> : null}
      {showBody ? view.body : null}
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
