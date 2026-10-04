import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, CircleDashed, CircleHelp, CircleX, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { errorMessage, Popover, type WorkbenchActions } from "tau";
import { checksPipelines } from "./pipeline.js";
import { PipelineGraph, usePipelineFacts } from "./pipeline-view.js";
import { checksRollup, checksSummary } from "./pull-request-logic.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestCheck } from "./protocol.js";
import { checksLabel } from "./requests.js";
import type { StripRequest } from "./pull-request-strip-logic.js";

/** The existing Actions job model in a vertical, read-only card popover. */
export function WorkspaceRequestChecks({ request, client, actions, details }: {
  request: StripRequest;
  client?: PullRequestClient;
  actions: WorkbenchActions;
  details(): void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ url: string; checks?: PullRequestCheck[]; error?: string }>();
  const current = result?.url === request.url ? result : undefined;
  const checks = current?.checks;
  const facts = usePipelineFacts(client, request.url, checks ?? []);
  const pipelines = checksPipelines(checks ?? [], facts);
  useEffect(() => { setOpen(false); }, [request.url]);
  useEffect(() => {
    if (!open || !client) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await client.checks(request.url);
        if (!live) return;
        setResult({ url: request.url, checks: next });
        if (checksRollup(next) === "pending") timer = setTimeout(() => { if (document.visibilityState === "visible") void read(); else timer = setTimeout(() => void read(), 20_000); }, 20_000);
      } catch (error) { if (live) setResult({ url: request.url, error: errorMessage(error) }); }
    };
    void read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [open, client, request.url, attempt]);
  const headline = current?.error ? "Checks unavailable" : checks ? checksSummary(checks) : checksLabel(request.checks) ?? "Checks";
  const aggregate = request.checks;
  const rollup = current?.error ? undefined : checks ? checksRollup(checks) : aggregate && aggregate.total > 0 ? aggregate.failed > 0 ? "failing" : aggregate.pending > 0 ? "pending" : aggregate.passed > 0 ? "passing" : undefined : undefined;
  const Icon = current?.error ? TriangleAlert : rollup === "passing" ? CircleCheck : rollup === "failing" ? CircleX : rollup === "pending" ? CircleDashed : CircleHelp;
  return <>
    <button ref={anchor} type="button" className={`workspace-request-checks-trigger workspace-card-split-accessory workspace-card-accessory${current?.error ? " checks-error" : rollup ? ` checks-${rollup}` : ""}`} title={current?.error ?? headline} aria-label={`Pull request checks, ${headline}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="workspace-card-status"><Icon size={16} aria-hidden /></span><span className="workspace-card-tail"><ChevronDown className="workspace-card-chevron" size={16} aria-hidden /></span>
    </button>
    {open ? <Popover anchor={anchor} align="end" label="Pull request checks" className="workspace-request-checks-popover" onClose={() => setOpen(false)}>
      <header><strong>{headline}</strong><button type="button" aria-label="Refresh checks" className="workspace-check-details" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} aria-hidden /></button></header>
      {!client ? <p role="status">Checks are unavailable on this connection.</p> : current?.error ? <p role="alert">{current.error}</p> : !checks ? <p role="status">Loading checks…</p> : checks.length === 0 ? <p role="status">No checks reported.</p> : <PipelineGraph pipelines={pipelines} actions={actions} variant="vertical" />}
      <button type="button" className="workspace-check-details" onClick={() => { setOpen(false); details(); }}>View all checks<ExternalLink size={16} aria-hidden /></button>
    </Popover> : null}
  </>;
}
