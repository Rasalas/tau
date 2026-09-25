import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, GitMerge, History, Lock, RotateCcw, Trash2 } from "lucide-react";
import { Empty, READ_ONLY_REASON, Skeleton, errorMessage, tooltipProps, useCommandAllowed, type WorkbenchActions } from "tau";
import { deployCounts, planSummary } from "./deploy-protocol.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { seqList, type RollbackFilePlan, type RollbackPreview, type RollbackResult } from "./rollback-protocol.js";
import type { ServerViewParts } from "./server-view.js";
import { ago } from "./status-model.js";
import { Group, PlanRow } from "./upload-panel.js";
import type { HistoryDeployment, HistoryEntry, ServerDiffSource, ServerHistory, TargetStatus } from "./view-protocol.js";

const DEPLOYMENT_STATUS: Record<HistoryDeployment["status"], string> = { uploaded: "not committed", verified: "checked, not committed", committed: "committed", "rolled-back": "rolled back" };

export function historyTitle(entry: HistoryEntry, first: boolean): string {
  if (entry.deployment) return entry.deployment.kind === "rollback" ? `Rollback ${entry.deployment.seq}` : `Deployment ${entry.deployment.seq}`;
  if (entry.kind === "read") return first ? "First read of the server" : "Read from the server";
  return entry.subject;
}

/** A deployment's line; `tagged`: its status shows as a tag already, only who rolled it back is added. */
export function deploymentMeta(deployment: HistoryDeployment, tagged = false): string {
  const rolledBy = deployment.status === "rolled-back" && deployment.rolledBackBy ? `by ${deployment.rolledBackBy}` : "";
  return [
    deployment.rollbackOf !== undefined ? `undid ${deployment.rollbackOf}` : "",
    tagged ? (rolledBy ? `rolled back ${rolledBy}` : "") : `${DEPLOYMENT_STATUS[deployment.status]}${rolledBy ? ` ${rolledBy}` : ""}`,
    deployment.branch ? `from ${deployment.branch}` : "",
    deployment.failed ? `${deployment.failed} failed` : "",
  ].filter(Boolean).join(" · ");
}

/** The history's own reading of an entry: what it changed on the server. */
export function entryCounts(entry: HistoryEntry): string {
  return [entry.added ? `${entry.added} new` : "", entry.modified ? `${entry.modified} changed` : "", entry.deleted ? `${entry.deleted} deleted` : ""].filter(Boolean).join(" · ") || "no changes";
}

export const HISTORY_CLEANED = "Older history was cleaned up (Settings → Servers → History).";

/** Roll back, and mark as checked, for one deployment of the list. */
function DeploymentActions({ deployment, busy, onRollBack, onMark }: {
  deployment: HistoryDeployment;
  busy: boolean;
  onRollBack(): void;
  onMark(checked: boolean): void;
}) {
  const canRollBack = useCommandAllowed(SERVERS_EXTENSION_ID, "rollback");
  const canMark = useCommandAllowed(SERVERS_EXTENSION_ID, "deployment-mark");
  const markable = deployment.status === "uploaded" || deployment.status === "verified";
  return (
    <div className="servers-plan-actions servers-history-actions">
      {deployment.status !== "rolled-back" ? (
        <button type="button" className="text-button" disabled={busy || !canRollBack} {...tooltipProps(canRollBack ? "See what a rollback would write before anything changes" : READ_ONLY_REASON)} onClick={onRollBack}>
          <RotateCcw size={12} aria-hidden="true" />Roll back…
        </button>
      ) : null}
      {markable && deployment.status === "uploaded" ? (
        <button type="button" className="text-button" disabled={busy || !canMark} {...tooltipProps(canMark ? "You checked it on the server; the mark stays until it is committed" : READ_ONLY_REASON)} onClick={() => onMark(true)}>
          <CheckCircle2 size={12} aria-hidden="true" />Mark as checked
        </button>
      ) : null}
      {markable && deployment.status === "verified" ? (
        <button type="button" className="text-button" disabled={busy || !canMark} {...(canMark ? {} : tooltipProps(READ_ONLY_REASON))} onClick={() => onMark(false)}>Not checked after all</button>
      ) : null}
    </div>
  );
}

function HistoryList({ entries, truncated, active, busy, onFile, onRollBack, onMark }: {
  entries: readonly HistoryEntry[];
  truncated: boolean;
  active: ServerDiffSource | undefined;
  busy: boolean;
  onFile(entry: HistoryEntry, path: string): void;
  onRollBack(entry: HistoryEntry & { deployment: HistoryDeployment }): void;
  onMark(seq: number, checked: boolean): void;
}) {
  const [open, setOpen] = useState<string | undefined>(entries[0]?.commit);
  return (
    <>
      <ol className="servers-history" aria-label="History">
        {entries.map((entry) => {
          const expanded = open === entry.commit;
          const first = !entry.parent;
          const { deployment } = entry;
          return (
            <li key={entry.commit} className={`servers-history-entry${deployment?.status === "rolled-back" ? " rolled-back" : ""}`}>
              <button type="button" className="servers-history-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : entry.commit)}>
                <ChevronRight size={12} className="chev" aria-hidden="true" />
                <span className="servers-history-title">{historyTitle(entry, first)}</span>
                {deployment ? <span className={`servers-file-tag status-${deployment.status}`}>{DEPLOYMENT_STATUS[deployment.status]}</span> : null}
                <time dateTime={entry.at} {...tooltipProps(new Date(entry.at).toLocaleString())}>{ago(entry.at)}</time>
              </button>
              <p className="servers-history-meta">{first ? `${entry.added} files` : entryCounts(entry)}{deployment && deploymentMeta(deployment, true) ? <> · {deploymentMeta(deployment, true)}</> : null}</p>
              {expanded && deployment?.note ? <p className="servers-history-meta note">{deployment.note}</p> : null}
              {expanded && deployment ? <DeploymentActions deployment={deployment} busy={busy} onRollBack={() => onRollBack({ ...entry, deployment })} onMark={(checked) => onMark(deployment.seq, checked)} /> : null}
              {expanded && !first ? (
                <ul className="servers-files">
                  {entry.files.map((file) => {
                    const current = active?.source === "history" && active.commit === entry.commit && active.path === file.path;
                    return (
                      <li key={file.path} className={`servers-file${current ? " active" : ""}`}>
                        <button type="button" className="servers-file-open" aria-current={current} onClick={() => onFile(entry, file.path)}>
                          <span className={`servers-change ${file.change}`} aria-hidden="true">{file.change === "added" ? "A" : file.change === "deleted" ? "D" : "M"}</span>
                          <span className="servers-file-name">{file.path}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
      {truncated ? <p className="servers-empty-line servers-history-end">{HISTORY_CLEANED}</p> : null}
    </>
  );
}

/** Overwrite a file the server changed since the deployment: a second click, like the upload's. */
function OverwriteAction({ file, forced, busy, onForce }: { file: RollbackFilePlan; forced: boolean; busy: boolean; onForce(path: string, force: boolean): void }) {
  const [asking, setAsking] = useState(false);
  if (forced) {
    return <div className="servers-plan-actions"><span className="servers-file-tag danger">Will overwrite the server's file</span><button type="button" className="text-button" onClick={() => onForce(file.path, false)}>Don't overwrite</button></div>;
  }
  if (asking) {
    return (
      <div className="servers-plan-actions" role="group" aria-label={`Overwrite ${file.path} on the server?`}>
        <span>{file.newer ? `Deployment ${file.newer}'s change there is lost` : "The server's change is lost there"}; Tau keeps a copy.</span>
        <button type="button" className="text-button" onClick={() => setAsking(false)}>Cancel</button>
        <button type="button" className="text-button danger" onClick={() => { setAsking(false); onForce(file.path, true); }}>Overwrite</button>
      </div>
    );
  }
  return <div className="servers-plan-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setAsking(true)}>{file.op === "delete" ? "Delete anyway…" : "Overwrite anyway…"}</button></div>;
}

function RollbackGroups({ name, files, force, busy, done = false, onOpen, onForce }: {
  /** "Deployment 3" or "Rollback 4". */
  name: string;
  files: readonly RollbackFilePlan[];
  force: ReadonlySet<string>;
  busy: boolean;
  done?: boolean;
  onOpen(path: string): void;
  onForce(path: string, force: boolean): void;
}) {
  const of = (test: (file: RollbackFilePlan) => boolean) => files.filter(test);
  const back = of((file) => file.outcome === "upload" && !file.merged);
  const merged = of((file) => file.outcome === "upload" && file.merged === true);
  const deleted = of((file) => file.outcome === "delete");
  const conflicts = of((file) => file.outcome === "conflict");
  const already = of((file) => file.outcome === "same" || file.outcome === "gone");
  const blocked = of((file) => file.outcome === "blocked" || file.outcome === "stale");
  const row = (file: RollbackFilePlan, children?: ReactNode) => <PlanRow key={file.path} file={file} onOpen={onOpen}>{children}</PlanRow>;
  return (
    <>
      <Group label={done ? "Put back" : "Goes back"} files={back} icon={<RotateCcw size={12} aria-hidden="true" />}>{back.map((file) => row(file))}</Group>
      <Group label={done ? "Merged three-way" : "Merges three-way"} files={merged} icon={<GitMerge size={12} aria-hidden="true" />} note={`${name}'s change is taken out; the later change stays.`}>{merged.map((file) => row(file))}</Group>
      <Group label="Deleted on the server" files={deleted} tone="danger" icon={<Trash2 size={12} aria-hidden="true" />} note={`${name} added ${deleted.length === 1 ? "it" : "them"}. Tau keeps a copy of each.`}>{deleted.map((file) => row(file))}</Group>
      <Group label="Changed on the server since" files={conflicts} tone="warn" icon={<AlertTriangle size={12} aria-hidden="true" />} note={done ? "Left as they are." : "Left as they are unless you say otherwise."}>
        {conflicts.map((file) => row(file, done ? null : <OverwriteAction file={file} forced={force.has(file.path)} busy={busy} onForce={onForce} />))}
      </Group>
      <Group label="Already as before" files={already} tone="muted">{already.map((file) => row(file))}</Group>
      <Group label="Not possible" files={blocked} tone="muted" icon={<Lock size={12} aria-hidden="true" />}>{blocked.map((file) => row(file))}</Group>
    </>
  );
}

type RollbackStage =
  | { kind: "preview"; preview?: RollbackPreview; error?: string }
  | { kind: "running"; preview: RollbackPreview }
  | { kind: "result"; result: RollbackResult };

/**
 * Rolling back one deployment: what would go back, read from the server
 * without writing; later deployments on the same files named, with a
 * three-way merge to take only this one's change out; then the rollback on
 * the user's click and what came of it.
 */
function RollbackPanel({ parts, actions, cwd, targetId, entry, onOpen, onClose, onOther }: {
  parts: ServerViewParts;
  actions: WorkbenchActions;
  cwd: string;
  targetId: string;
  entry: HistoryEntry & { deployment: HistoryDeployment };
  onOpen(path: string): void;
  onClose(changed: boolean): void;
  onOther(seq: number): void;
}) {
  const seq = entry.deployment.seq;
  const canRollBack = useCommandAllowed(SERVERS_EXTENSION_ID, "rollback");
  const [threeWay, setThreeWay] = useState(false);
  const [force, setForce] = useState<ReadonlySet<string>>(new Set());
  const [stage, setStage] = useState<RollbackStage>({ kind: "preview" });

  useEffect(() => {
    let live = true;
    setStage({ kind: "preview" });
    parts.host.invoke("rollback-preview", { cwd, targetId, seq, threeWay }).then(
      (value) => { if (live) setStage({ kind: "preview", preview: value as RollbackPreview }); },
      (failure: unknown) => { if (live) setStage({ kind: "preview", error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [parts.host, cwd, targetId, seq, threeWay]);

  const setForced = (path: string, value: boolean) => setForce((current) => {
    const next = new Set(current);
    if (value) next.add(path); else next.delete(path);
    return next;
  });

  const run = (preview: RollbackPreview) => {
    const thread = actions.activeThread();
    const threadId = thread?.sessionId && thread.cwd === cwd ? thread.sessionId : undefined;
    setStage({ kind: "running", preview });
    parts.host.invoke("rollback", { cwd, targetId, seq, threeWay, force: [...force], ...(threadId ? { threadId } : {}) }).then(
      (value) => setStage({ kind: "result", result: value as RollbackResult }),
      (failure: unknown) => { actions.notify(errorMessage(failure)); setStage({ kind: "preview", preview }); },
    ).finally(() => { void parts.store.load(cwd, true); });
  };

  const name = `${entry.deployment.kind === "rollback" ? "Rollback" : "Deployment"} ${seq}`;
  const title = `Roll back ${name.toLowerCase()}`;
  if (stage.kind === "result") {
    const { result } = stage;
    const left = result.files.filter((file) => file.outcome === "conflict" || file.outcome === "blocked").length;
    return (
      <div className="servers-upload">
        <header className="servers-upload-head">
          {result.deployment
            ? <p className={`servers-banner ${result.rolledBack ? "ok" : "warn"}`} role="status">{result.rolledBack ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}<span>Rollback {result.deployment.seq}: {deployCounts(result.deployment.files)} on the server.{result.rolledBack ? ` ${name} is undone.` : ` ${left} ${left === 1 ? "file stays" : "files stay"} as ${left === 1 ? "it is" : "they are"}.`}</span></p>
            : <p className="servers-banner warn" role="status"><AlertTriangle size={13} aria-hidden="true" /><span>{result.rolledBack ? `The server already held everything as before ${name.toLowerCase()}; nothing was written.` : "Nothing was written."}</span></p>}
        </header>
        <div className="servers-upload-plan">
          {result.failed.length > 0 ? (
            <section className="servers-plan-group tone-danger" aria-label="Failed">
              <h3 className="servers-group-head"><AlertTriangle size={12} aria-hidden="true" />Failed <span className="servers-count">{result.failed.length}</span></h3>
              <ul className="servers-files">{result.failed.map((failure) => <li key={failure.path} className="servers-file"><span className="servers-file-name">{failure.path}<small>{failure.message}</small></span></li>)}</ul>
            </section>
          ) : null}
          <RollbackGroups name={name} files={result.files.filter((file) => !result.failed.some((failure) => failure.path === file.path))} force={new Set()} busy={false} done onOpen={onOpen} onForce={() => undefined} />
        </div>
        <footer className="servers-upload-bar"><button type="button" className="chrome-button" onClick={() => onClose(true)}>Done</button></footer>
      </div>
    );
  }

  const shown = stage.preview;
  const busy = stage.kind === "running";
  const summary = shown ? planSummary(shown.files.map((file) => ({ ...file, ...(force.has(file.path) ? { forced: true } : {}) }))) : undefined;
  const writes = (summary?.changed ?? 0) + (summary?.deleted ?? 0);
  return (
    <div className="servers-upload" aria-label={title}>
      <header className="servers-upload-head">
        <button type="button" className="icon-button" aria-label="Back to the history" disabled={busy} onClick={() => onClose(false)}><ArrowLeft size={14} /></button>
        <h2>{title}</h2>
        <span className="spacer" />
        <button
          type="button"
          className={`chrome-button servers-three-way${threeWay ? " active" : ""}`}
          aria-pressed={threeWay}
          disabled={busy}
          {...tooltipProps("Where the server's file changed since, take only this deployment's change out of it")}
          onClick={() => setThreeWay(!threeWay)}
        ><GitMerge size={12} aria-hidden="true" />Merge three-way</button>
      </header>
      <div className="servers-upload-plan" aria-busy={!shown}>
        {stage.kind === "preview" && stage.error ? <p className="servers-error" role="alert">{stage.error}</p>
          : !shown ? <><p className="servers-group-note">Reading the deployment's files on the server…</p><Skeleton shape="block" /></>
          : (
            <>
              {shown.newer.length > 0 ? (
                <p className="servers-banner warn servers-banner-stack" role="note">
                  <AlertTriangle size={13} aria-hidden="true" />
                  <span>{shown.newer.length === 1 ? `Deployment ${shown.newer[0]} changed` : `Deployments ${seqList([...shown.newer].sort((a, b) => a - b))} changed`} some of these files afterwards. Roll {shown.newer.length === 1 ? "it" : "them"} back first, or merge three-way.</span>
                  <button type="button" className="text-button" disabled={busy} onClick={() => onOther(shown.newer[0]!)}>Roll back {shown.newer[0]} first</button>
                </p>
              ) : null}
              <RollbackGroups name={name} files={shown.files} force={force} busy={busy} onOpen={onOpen} onForce={setForced} />
            </>
          )}
      </div>
      <footer className="servers-upload-bar">
        <button type="button" className="chrome-button" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
        <button
          type="button"
          className="chrome-button primary"
          disabled={!shown || busy || !canRollBack || writes === 0}
          {...(canRollBack ? {} : tooltipProps(READ_ONLY_REASON))}
          onClick={() => { if (shown) run(shown); }}
        >{busy ? "Rolling back…" : summary && writes > 0 ? summary.label.replace(/^Upload/u, "Roll back") : "Roll back"}</button>
      </footer>
    </div>
  );
}

/**
 * The history tab: every recorded server state and deployment, a deployment's
 * rollback and its "checked" mark. `main` is the diff of the chosen file.
 */
export function HistoryPanel({ parts, actions, cwd, target, active, onFile, main }: {
  parts: ServerViewParts;
  actions: WorkbenchActions;
  cwd: string;
  target: TargetStatus;
  active: ServerDiffSource | undefined;
  onFile(entry: HistoryEntry, path: string): void;
  main: ReactNode;
}) {
  const [history, setHistory] = useState<{ entries?: HistoryEntry[]; truncated?: boolean; error?: string }>({});
  const [rolling, setRolling] = useState<HistoryEntry & { deployment: HistoryDeployment }>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const targetId = target.targetId;
  const mirrorCommit = target.mirror?.commit;

  useEffect(() => {
    let live = true;
    parts.host.invoke("server-history", { cwd, targetId }).then(
      (value) => { if (live) setHistory({ entries: (value as ServerHistory).entries, truncated: (value as ServerHistory).truncated === true }); },
      (failure: unknown) => { if (live) setHistory({ error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [parts.host, cwd, targetId, mirrorCommit, target.deployments, reload]);

  const mark = (seq: number, checked: boolean) => {
    setBusy(true);
    parts.host.invoke("deployment-mark", { cwd, targetId, seq, checked }).then(
      () => setReload((value) => value + 1),
      (failure: unknown) => actions.notify(errorMessage(failure)),
    ).finally(() => setBusy(false));
  };

  if (history.error) return <p className="servers-error" role="alert">{history.error}</p>;
  if (!history.entries) return <Skeleton shape="card" />;
  if (history.entries.length === 0) {
    return <Empty icon={<History size={18} />} title="No history yet" description={history.truncated ? HISTORY_CLEANED : "Each read of the server, and each upload, is recorded here."} />;
  }
  const other = (seq: number) => {
    const entry = history.entries?.find((candidate) => candidate.deployment?.seq === seq);
    if (entry?.deployment) setRolling({ ...entry, deployment: entry.deployment });
  };
  return (
    <div className="servers-split">
      <aside className="servers-aside">
        {rolling ? (
          <RollbackPanel
            key={rolling.deployment.seq}
            parts={parts}
            actions={actions}
            cwd={cwd}
            targetId={targetId}
            entry={rolling}
            onOpen={(path) => onFile(rolling, path)}
            onClose={(changed) => { setRolling(undefined); if (changed) setReload((value) => value + 1); }}
            onOther={other}
          />
        ) : (
          <HistoryList entries={history.entries} truncated={history.truncated === true} active={active} busy={busy} onFile={onFile} onRollBack={setRolling} onMark={mark} />
        )}
      </aside>
      <main className="servers-main">{main}</main>
    </div>
  );
}
