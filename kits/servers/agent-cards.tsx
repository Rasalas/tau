import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Server, Upload } from "lucide-react";
import {
  READ_ONLY_REASON, errorMessage, tooltipProps, useCommandAllowed,
  type DesktopExtensionContext, type HostExtensionClient, type ToolCardProps, type ToolPresentation, type UiToolRun,
} from "tau";
import { SERVER_TOOLS, parseServerMark, parseUploadProposal, serverToolName, type UploadProposal } from "./agent-protocol.js";
import { deployCounts, planSummary, type DeployFilePlan, type DeployOp, type DeploymentRecord, type DeployResult } from "./deploy-protocol.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { openTarget } from "./status-parts.js";

const LETTERS: Record<DeployOp, string> = { add: "A", modify: "M", delete: "D" };
const CHANGE_CLASS: Record<DeployOp, string> = { add: "added", modify: "modified", delete: "deleted" };
const OUTCOME_WORDS: Record<DeployFilePlan["outcome"], string | undefined> = {
  upload: undefined,
  delete: "deleted on the server",
  same: "already there",
  gone: "already gone",
  conflict: "changed on the server",
  blocked: "not uploaded",
  stale: "changed meanwhile",
};

const writes = (file: DeployFilePlan) => file.outcome === "upload" || file.outcome === "delete";

/** The server a call went to: from its answer, else from what the agent named. */
function markOf(tool: UiToolRun): string | undefined {
  return parseServerMark(tool.output)?.label ?? (typeof tool.args.target === "string" && tool.args.target ? tool.args.target : undefined);
}

/** A server tool's row in the transcript, with the server it reached. */
export function serverToolPresentation(tool: UiToolRun): ToolPresentation {
  const name = serverToolName(tool.name);
  const label = markOf(tool);
  // A refused call has no answer to name its server by.
  const base = label ? { title: `server · ${label}`, source: `server ${label}` } : { title: "server", source: "server" };
  const arg = (key: string) => (typeof tool.args[key] === "string" ? tool.args[key] as string : "");
  switch (name) {
    case SERVER_TOOLS.exec:
      return { ...base, glyph: "$", tone: "shell", detail: `${tool.args.cwd === "tmp" ? "~/tmp " : ""}${arg("command")}` };
    case SERVER_TOOLS.putTmp:
      return { ...base, glyph: "±", tone: "write", detail: `~/tmp/${arg("path").replace(/^~\/tmp\/+/u, "")}` };
    case SERVER_TOOLS.diff:
      return { ...base, glyph: "→", tone: "read", detail: `diff ${Array.isArray(tool.args.paths) ? (tool.args.paths as unknown[]).join(" ") : ""}` };
    case SERVER_TOOLS.list:
      return { ...base, glyph: "→", tone: "read", detail: `ls ${arg("path") || "."}` };
    case SERVER_TOOLS.read:
      return { ...base, glyph: "→", tone: "read", detail: arg("path") };
    default:
      return { ...base, glyph: "→", tone: "read", detail: "status" };
  }
}

/** A deployment the card's click made: same thread, after the proposal, only files it proposed. */
function fromThisCard(record: DeploymentRecord, proposal: UploadProposal, proposedAt: number): boolean {
  const proposed = new Set(proposal.files.map((file) => file.path));
  return record.origin.via === "card" && record.origin.threadId === proposal.threadId && Date.parse(record.at) >= proposedAt
    && record.files.length > 0 && record.files.every((file) => proposed.has(file.path));
}

type CardStage = { kind: "idle" } | { kind: "confirming" } | { kind: "uploading" } | { kind: "done"; result: DeployResult } | { kind: "recorded"; seq: number; counts: string };

function ProposalView({ tool, host, actions, compact }: { tool: UiToolRun; host: HostExtensionClient; actions: ToolCardProps["actions"]; compact: boolean }) {
  const proposal = tool.status === "done" ? parseUploadProposal(tool.output) : undefined;
  const canDeploy = useCommandAllowed(SERVERS_EXTENSION_ID, "deploy");
  const [stage, setStage] = useState<CardStage>({ kind: "idle" });
  const proposedAt = tool.endedAt ?? tool.startedAt;
  const workspace = proposal?.workspace;
  const targetId = proposal?.target.id;

  // After a reload the click lives only in the journal.
  useEffect(() => {
    if (!proposal || !workspace || !targetId) return;
    let live = true;
    host.invoke("deployments", { cwd: workspace, targetId }).then((value) => {
      const record = (value as { deployments?: DeploymentRecord[] }).deployments?.find((entry) => fromThisCard(entry, proposal, proposedAt));
      if (live && record) setStage((current) => (current.kind === "idle" ? { kind: "recorded", seq: record.seq, counts: deployCounts(record.files) } : current));
    }, () => undefined);
    return () => { live = false; };
    // Once per proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, workspace, targetId]);

  if (tool.status === "running") {
    return <section className="servers-proposal" aria-busy="true"><header><Upload size={13} aria-hidden="true" /><strong>Preparing an upload proposal…</strong></header></section>;
  }
  if (!proposal) {
    return (
      <section className="servers-proposal">
        <header><AlertTriangle size={13} aria-hidden="true" /><strong>No upload proposed</strong></header>
        <p className="servers-proposal-note">{(tool.output ?? "").split("\n").slice(-3).join(" ") || "The proposal failed."}</p>
      </section>
    );
  }
  const chosen = proposal.files.filter(writes);
  const summary = planSummary(chosen);
  const upload = () => {
    setStage({ kind: "uploading" });
    host.invoke("deploy", {
      cwd: proposal.workspace, targetId: proposal.target.id, files: chosen.map((file) => ({ path: file.path, op: file.op })),
      via: "card", threadId: proposal.threadId, ...(proposal.note ? { note: proposal.note } : {}),
    }).then(
      (value) => setStage({ kind: "done", result: value as DeployResult }),
      (failure: unknown) => { actions.notify(errorMessage(failure)); setStage({ kind: "idle" }); },
    );
  };
  const open = () => { openTarget(actions, proposal.workspace, proposal.target.id); };
  const done = stage.kind === "done" ? stage.result : undefined;
  return (
    <section className={`servers-proposal${compact ? " compact" : ""}`} aria-label={`Upload proposed for ${proposal.target.label}`}>
      <header>
        <Upload size={13} aria-hidden="true" />
        <strong>Upload proposed for {proposal.target.label}</strong>
        <small className="servers-proposal-host" {...tooltipProps(proposal.target.address)}><Server size={11} aria-hidden="true" />{proposal.target.address.replace(/^[a-z]+:\/\//u, "")}</small>
      </header>
      {proposal.note ? <p className="servers-proposal-note">{proposal.note}</p> : null}
      {proposal.warnings.map((warning) => <p key={warning} className="servers-banner warn" role="note"><AlertTriangle size={13} aria-hidden="true" /><span>{warning}</span></p>)}
      <ul className="servers-files">
        {proposal.files.map((file) => (
          <li key={file.path} className={`servers-file outcome-${file.outcome}${writes(file) ? "" : " muted"}`}>
            <span className={`servers-change ${CHANGE_CLASS[file.op]}`} aria-hidden="true">{LETTERS[file.op]}</span>
            <span className="servers-file-name">{file.path}{file.reason ? <small>{file.reason}</small> : null}</span>
            {OUTCOME_WORDS[file.outcome] ? <span className={`servers-file-tag${file.outcome === "delete" || file.outcome === "conflict" ? " danger" : ""}`}>{OUTCOME_WORDS[file.outcome]}</span> : null}
          </li>
        ))}
        {proposal.leftOut.map((entry) => (
          <li key={`left-${entry.path}`} className="servers-file muted"><span className="servers-change" aria-hidden="true">·</span><span className="servers-file-name">{entry.path}<small>{entry.reason}</small></span></li>
        ))}
      </ul>
      {proposal.kept.length ? <p className="servers-proposal-note">{proposal.kept.length} local {proposal.kept.length === 1 ? "deletion stays" : "deletions stay"} on the server.</p> : null}
      {done ? (
        done.deployment
          ? <p className="servers-banner ok" role="status"><CheckCircle2 size={13} aria-hidden="true" /><span>Deployment {done.deployment.seq}: {deployCounts(done.deployment.files)} on the server.{done.failed.length || done.files.some((file) => file.outcome === "conflict") ? " Some files did not go up; the server view has them." : ""}</span></p>
          : <p className="servers-banner warn" role="status"><AlertTriangle size={13} aria-hidden="true" /><span>Nothing was uploaded: {done.files.some((file) => file.outcome === "conflict") ? "the server changed since Tau last read it" : "nothing in it would change the server any more"}. The server view shows why.</span></p>
      ) : stage.kind === "recorded" ? (
        <p className="servers-banner ok" role="status"><CheckCircle2 size={13} aria-hidden="true" /><span>Uploaded as deployment {stage.seq}: {stage.counts}.</span></p>
      ) : null}
      {stage.kind === "confirming" ? (
        <footer role="group" aria-label={`Upload to ${proposal.target.label}?`}>
          <span className="servers-proposal-hint">Upload to {proposal.target.label} now?</span>
          <button type="button" className="chrome-button" onClick={() => setStage({ kind: "idle" })}>Cancel</button>
          <button type="button" className="chrome-button primary" onClick={upload}>{summary.label}</button>
        </footer>
      ) : (
      <footer>
        <span className="servers-proposal-hint">{done || stage.kind === "recorded" ? "" : chosen.length ? "Nothing goes up until you click Upload." : "Nothing to upload."}</span>
        <button type="button" className="chrome-button" onClick={open}>Server view</button>
        {done || stage.kind === "recorded" || !chosen.length ? null : (
          <button
            type="button"
            className="chrome-button primary"
            disabled={!canDeploy || stage.kind === "uploading"}
            {...tooltipProps(canDeploy ? "Tau reads the server again and never overwrites a change made there" : READ_ONLY_REASON)}
            // On a phone a tap asks once more before anything goes up.
            onClick={compact ? () => setStage({ kind: "confirming" }) : upload}
          >{stage.kind === "uploading" ? "Uploading…" : summary.label}</button>
        )}
      </footer>
      )}
    </section>
  );
}

/** One card per `server_propose_upload`: what would go up, and the only button that uploads it. */
export function createProposalCard(host: HostExtensionClient, options: { compact?: boolean } = {}) {
  return function ProposalCard({ tools, actions }: ToolCardProps) {
    return <>{tools.map((tool) => <ProposalView key={tool.id} tool={tool} host={host} actions={actions} compact={options.compact === true} />)}</>;
  };
}

/** The server tools' rows with the server they reached, and the upload proposal's card. */
export function registerAgentCards(context: DesktopExtensionContext): () => void {
  const profiles = ["desktop", "web", "compact"] as const;
  const disposers = [
    context.registerToolRenderer(
      "servers.tools",
      (tool) => {
        const name = serverToolName(tool.name);
        return name !== undefined && name !== SERVER_TOOLS.proposeUpload;
      },
      serverToolPresentation,
      { profiles: [...profiles] },
    ),
    context.registerToolCard({
      id: "servers.upload-proposal",
      match: (tool) => serverToolName(tool.name) === SERVER_TOOLS.proposeUpload,
      profiles: ["desktop", "web"],
      Component: createProposalCard(context.host),
    }),
    context.registerToolCard({
      id: "servers.upload-proposal.compact",
      match: (tool) => serverToolName(tool.name) === SERVER_TOOLS.proposeUpload,
      profiles: ["compact"],
      Component: createProposalCard(context.host, { compact: true }),
    }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
