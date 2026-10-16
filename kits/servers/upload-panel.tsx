import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, GitMerge, Lock, Trash2, Upload } from "lucide-react";
import { READ_ONLY_REASON, Skeleton, errorMessage, tooltipProps, useCommandAllowed, type WorkbenchActions } from "tau";
import {
  deployCounts, planSummary,
  type DeployFilePlan, type DeployOp, type DeployPreview, type DeployRequestFile, type DeployResolveAction, type DeployResolveResult, type DeployResult,
} from "./deploy-protocol.js";
import { PendingList, type PendingSelection } from "./pending-list.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import type { ServerViewParts } from "./server-view.js";
import type { PendingUploadRow, TargetStatus } from "./view-protocol.js";
import { ServerFolderPicker } from "./folder-picker.js";

const OPS = { added: "add", modified: "modify", deleted: "delete" } as const;
const LETTERS: Record<DeployOp, string> = { add: "A", modify: "M", delete: "D" };
const CHANGE_CLASS: Record<DeployOp, string> = { add: "added", modify: "modified", delete: "deleted" };

type Stage =
  | { kind: "choose" }
  | { kind: "preview"; files: DeployRequestFile[]; preview?: DeployPreview; error?: string }
  | { kind: "uploading"; preview: DeployPreview }
  | { kind: "result"; result: DeployResult };

/** A pending row as the upload asks for it. */
const requestOf = (row: PendingUploadRow): DeployRequestFile => ({ path: row.path, op: OPS[row.change] });

export function PlanRow({ file, onOpen, children }: { file: DeployFilePlan; onOpen(path: string): void; children?: ReactNode }) {
  return (
    <li className={`servers-file servers-plan-row outcome-${file.outcome}`}>
      <button type="button" className="servers-file-open" aria-label={file.path} onClick={() => onOpen(file.path)}>
        <span className={`servers-change ${CHANGE_CLASS[file.op]}`} aria-hidden="true">{LETTERS[file.op]}</span>
        <span className="servers-file-name">{file.path}{file.reason ? <small>{file.reason}</small> : null}</span>
      </button>
      {children}
    </li>
  );
}

export function Group({ label, files, tone, note, icon, children }: { label: string; files: readonly unknown[]; tone?: "danger" | "warn" | "muted"; note?: string; icon?: ReactNode; children: ReactNode }) {
  if (files.length === 0) return null;
  return (
    <section className={`servers-plan-group${tone ? ` tone-${tone}` : ""}`} aria-label={label}>
      <h3 className="servers-group-head">{icon}{label} <span className="servers-count">{files.length}</span></h3>
      {note ? <p className="servers-group-note">{note}</p> : null}
      <ul className="servers-files">{children}</ul>
    </section>
  );
}

/** The two-step buttons of a conflict: take the server's file, merge it in, or overwrite the server anyway. */
function ConflictActions({ file, forced, canResolve, busy, onResolve, onForce }: {
  file: DeployFilePlan;
  forced: boolean;
  canResolve: boolean;
  busy: boolean;
  onResolve(path: string, action: DeployResolveAction): void;
  onForce(path: string, force: boolean): void;
}) {
  const [asking, setAsking] = useState<"take" | "force">();
  const disabled = busy || !canResolve;
  const tip = canResolve ? {} : tooltipProps(READ_ONLY_REASON);
  if (forced) {
    return <div className="servers-plan-actions"><span className="servers-file-tag danger">Will overwrite the server's change</span><button type="button" className="text-button" onClick={() => onForce(file.path, false)}>Don't overwrite</button></div>;
  }
  if (asking === "take") {
    return (
      <div className="servers-plan-actions" role="group" aria-label={`Take the server's ${file.path}?`}>
        <span>Your local changes to this file are replaced.</span>
        <button type="button" className="text-button" onClick={() => setAsking(undefined)}>Cancel</button>
        <button type="button" className="text-button danger" disabled={disabled} onClick={() => { setAsking(undefined); onResolve(file.path, "take-server"); }}>Replace mine</button>
      </div>
    );
  }
  if (asking === "force") {
    return (
      <div className="servers-plan-actions" role="group" aria-label={`Overwrite ${file.path} on the server?`}>
        <span>The server's change is lost there; Tau keeps a copy.</span>
        <button type="button" className="text-button" onClick={() => setAsking(undefined)}>Cancel</button>
        <button type="button" className="text-button danger" onClick={() => { setAsking(undefined); onForce(file.path, true); }}>Overwrite</button>
      </div>
    );
  }
  const both = file.op !== "delete" && file.server !== undefined;
  return (
    <div className="servers-plan-actions">
      <button type="button" className="text-button" disabled={disabled} {...tip} onClick={() => setAsking("take")}>Use the server's version</button>
      {both ? <button type="button" className="text-button" disabled={disabled} {...tip} onClick={() => onResolve(file.path, "merge")}><GitMerge size={12} aria-hidden="true" />Merge</button> : null}
      <button type="button" className="text-button" disabled={busy} onClick={() => setAsking("force")}>Overwrite anyway…</button>
    </div>
  );
}

/** What a plan says per outcome, as groups; conflicts carry their actions. */
function PlanGroups({ files, kept, force, canResolve, busy, done = false, onOpen, onResolve, onForce }: {
  files: readonly DeployFilePlan[];
  /** The upload ran: what went up is told in the past. */
  done?: boolean;
  kept: readonly string[];
  force: ReadonlySet<string>;
  canResolve: boolean;
  busy: boolean;
  onOpen(path: string): void;
  onResolve(path: string, action: DeployResolveAction): void;
  onForce(path: string, force: boolean): void;
}) {
  const of = (...outcomes: DeployFilePlan["outcome"][]) => files.filter((file) => outcomes.includes(file.outcome));
  const uploads = of("upload");
  const deletes = of("delete");
  const conflicts = of("conflict");
  const blocked = of("blocked");
  const already = of("same", "gone");
  const stale = of("stale");
  return (
    <>
      <Group label={done ? "Uploaded" : "Goes up"} files={uploads} icon={<Upload size={12} aria-hidden="true" />}>
        {uploads.map((file) => <PlanRow key={file.path} file={file} onOpen={onOpen} />)}
      </Group>
      <Group label="Deleted on the server" files={deletes} tone="danger" icon={<Trash2 size={12} aria-hidden="true" />} note={done ? "Tau kept a copy of each." : "Tau keeps a copy of each before deleting it."}>
        {deletes.map((file) => <PlanRow key={file.path} file={file} onOpen={onOpen} />)}
      </Group>
      <Group label="Review before uploading" files={conflicts} tone="warn" icon={<AlertTriangle size={12} aria-hidden="true" />} note="These files need your decision. Nothing is overwritten unless you say so.">
        {conflicts.map((file) => (
          <PlanRow key={file.path} file={file} onOpen={onOpen}>
            <ConflictActions file={file} forced={force.has(file.path)} canResolve={canResolve} busy={busy} onResolve={onResolve} onForce={onForce} />
          </PlanRow>
        ))}
      </Group>
      <Group label="Not uploaded" files={blocked} tone="muted" icon={<Lock size={12} aria-hidden="true" />}>
        {blocked.map((file) => <PlanRow key={file.path} file={file} onOpen={onOpen} />)}
      </Group>
      <Group label="Already on the server" files={already} tone="muted">
        {already.map((file) => <PlanRow key={file.path} file={file} onOpen={onOpen} />)}
      </Group>
      <Group label="Changed meanwhile" files={stale} tone="muted">
        {stale.map((file) => <PlanRow key={file.path} file={file} onOpen={onOpen} />)}
      </Group>
      <Group label="Stays on the server" files={kept} tone="warn" icon={<Trash2 size={12} aria-hidden="true" />} note="Deleted here, left out of this upload: they stay listed as not uploaded.">
        {kept.map((path) => <li key={path} className="servers-file muted"><span className="servers-file-name">{path}</span></li>)}
      </Group>
    </>
  );
}

/**
 * Choose files, inspect the current server versions, then confirm the upload.
 * Deletions are explicit choices. Only this click uploads; the agent never does.
 */
export function UploadPanel({ parts, actions, cwd, target, active, onOpen, onHolding, initialPaths, proposedThread }: {
  parts: ServerViewParts;
  actions: WorkbenchActions;
  cwd: string;
  target: TargetStatus;
  active?: string;
  initialPaths?: readonly string[];
  proposedThread?: string;
  onOpen(path: string): void;
  /** True from the preview until Done: keep the panel although nothing is left to upload, so the result stays. */
  onHolding?(holding: boolean): void;
}) {
  const canDeploy = useCommandAllowed(SERVERS_EXTENSION_ID, "deploy");
  const canResolve = useCommandAllowed(SERVERS_EXTENSION_ID, "deploy-resolve");
  const [choices, setChoices] = useState<Record<string, boolean>>(() => Object.fromEntries((initialPaths ?? []).filter((path) => target.pending.some((row) => row.path === path && !row.credentials && !row.blocked)).map((path) => [path, true])));
  const [stage, setStage] = useState<Stage>({ kind: "choose" });
  const [force, setForce] = useState<ReadonlySet<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [folderPicker, setFolderPicker] = useState(false);
  const [stopping, setStopping] = useState(false);
  const operation = useRef<string | undefined>(undefined);
  const fingerprint = target.connectionFingerprint;
  const targetId = target.targetId;
  const holding = stage.kind !== "choose";
  useEffect(() => { onHolding?.(holding); }, [onHolding, holding]);
  useEffect(() => () => onHolding?.(false), [onHolding]);
  useEffect(() => () => { const operationId = operation.current; if (operationId) void parts.host.invoke("cancel-server-operation", { cwd, targetId, operationId }).catch(() => undefined); }, [parts.host, cwd, targetId]);

  const chosen = (row: PendingUploadRow) => !row.blocked && (choices[row.path] ?? row.selected);
  const set = (path: string, value: boolean) => setChoices((current) => ({ ...current, [path]: value }));
  const selection: PendingSelection = {
    chosen,
    toggle(row) {
      if (row.blocked) return;
      set(row.path, !chosen(row));
    },
    ...(canDeploy ? {} : { disabledReason: READ_ONLY_REASON }),
  };
  const picked = target.pending.filter(chosen);
  const keptCount = target.pending.filter((row) => row.change === "deleted" && !row.blocked && !chosen(row)).length;

  const authorize = () => fingerprint ? parts.host.invoke("authorize-server", { cwd, targetId, fingerprint }) : Promise.resolve();
  const cancel = () => {
    const operationId = operation.current;
    if (operationId) void parts.host.invoke("cancel-server-operation", { cwd, targetId, operationId }).catch((failure: unknown) => actions.notify(errorMessage(failure), "error"));
    if (stage.kind === "uploading") { setStopping(true); return; }
    operation.current = undefined;
    setStage({ kind: "choose" }); setForce(new Set()); setResolving(false);
  };
  const preview = (files: DeployRequestFile[]) => {
    const operationId = crypto.randomUUID(); operation.current = operationId;
    setStage({ kind: "preview", files });
    authorize().then(() => operation.current === operationId ? parts.host.invoke("deploy-preview", { cwd, targetId, files, force: [...force], operationId }) : undefined).then(
      (value) => { if (operation.current === operationId) setStage((current) => current.kind === "preview" && current.files === files ? { ...current, preview: value as DeployPreview } : current); },
      (failure: unknown) => { if (operation.current === operationId) setStage((current) => current.kind === "preview" && current.files === files ? { ...current, error: errorMessage(failure) } : current); },
    ).finally(() => { if (operation.current === operationId) operation.current = undefined; });
  };

  const threadId = () => {
    const thread = actions.activeThread();
    return thread?.sessionId && thread.cwd === cwd ? thread.sessionId : undefined;
  };

  const upload = (shown: DeployPreview) => {
    const files = shown.files
      .filter((file) => file.outcome === "upload" || file.outcome === "delete" || (file.outcome === "conflict" && force.has(file.path)))
      .map((file) => ({ path: file.path, op: file.op }));
    const thread = proposedThread ?? threadId();
    const operationId = crypto.randomUUID(); operation.current = operationId;
    setStopping(false);
    setStage({ kind: "uploading", preview: shown });
    parts.host.invoke("deploy", { cwd, targetId, files, operationId, via: proposedThread ? "card" : "view", preview: { source: shown.source, observed: shown.observed, local: shown.local }, force: [...force].filter((path) => files.some((file) => file.path === path)), ...(thread ? { threadId: thread } : {}) }).then(
      (value) => { setStage({ kind: "result", result: value as DeployResult }); setChoices({}); setForce(new Set()); },
      (failure: unknown) => { actions.notify(errorMessage(failure), "error"); setStage({ kind: "preview", files, preview: shown }); },
    ).finally(() => { if (operation.current === operationId) operation.current = undefined; setStopping(false); void parts.store.load(cwd, true); });
  };

  const resolve = (path: string, action: DeployResolveAction) => {
    setResolving(true);
    const operationId = crypto.randomUUID(); operation.current = operationId;
    parts.host.invoke("deploy-resolve", { cwd, targetId, path, action, operationId }).then(
      (value) => {
        if (operation.current !== operationId) return;
        const result = value as DeployResolveResult;
        actions.notify(action === "take-server"
          ? result.deleted ? `${path} is deleted here too, as on the server.` : `${path} now holds the server's version.`
          : result.conflicts > 0 ? `${path} merged with ${result.conflicts} ${result.conflicts === 1 ? "conflict" : "conflicts"} marked; resolve ${result.conflicts === 1 ? "it" : "them"}, then upload.` : `${path} merged without conflicts; upload it when ready.`);
        setStage({ kind: "choose" });
        onOpen(path);
      },
      (failure: unknown) => actions.notify(errorMessage(failure), "error"),
    ).finally(() => { if (operation.current === operationId) operation.current = undefined; setResolving(false); void parts.store.load(cwd, true); });
  };

  const setForced = (path: string, value: boolean) => setForce((current) => {
    const next = new Set(current);
    if (value) next.add(path); else next.delete(path);
    return next;
  });

  if (folderPicker) return <ServerFolderPicker host={parts.host} cwd={cwd} target={target} actions={actions} onClose={() => { setFolderPicker(false); setStage({ kind: "choose" }); void parts.store.load(cwd, true); }} />;

  if (stage.kind === "choose") {
    return (
      <div className="servers-upload">
        <div className="servers-upload-select"><button type="button" className="text-button" disabled={!canDeploy} onClick={() => setChoices(Object.fromEntries(target.pending.filter((row) => row.change !== "deleted" && !row.blocked && !row.credentials).map((row) => [row.path, true])))}>Select files</button><button type="button" className="text-button" onClick={() => setChoices(Object.fromEntries(target.pending.map((row) => [row.path, false])))}>Clear</button></div>
        {target.pending.some((row) => row.unchecked) ? <p className="servers-group-note">Choose files from your current branch. The preview reads only your selection on the server.</p> : null}
        <PendingList rows={target.pending} total={target.pendingTotal} withheld={target.withheld} {...(active ? { active } : {})} onOpen={onOpen} selection={selection} />
        <footer className="servers-upload-bar">
          {keptCount > 0 ? <p className="servers-upload-note"><Trash2 size={12} aria-hidden="true" />{keptCount} {keptCount === 1 ? "deletion stays" : "deletions stay"} on the server</p> : null}
          <button
            type="button"
            className="chrome-button primary"
            disabled={!canDeploy || target.state === "incomplete" || picked.length === 0}
            {...tooltipProps(canDeploy ? "See what goes up before anything is written" : READ_ONLY_REASON)}
            onClick={() => preview(picked.map(requestOf))}
          >{picked.length ? `Review upload · ${picked.length}` : "Choose files to upload"}</button>
        </footer>
      </div>
    );
  }

  if (stage.kind === "result") {
    const { result } = stage;
    const deployment = result.deployment;
    const went = new Set(deployment?.files.map((file) => file.path));
    const failed = new Set(result.failed.map((failure) => failure.path));
    const files = result.files.flatMap((file): DeployFilePlan[] => {
      if (failed.has(file.path)) return [];
      if (went.has(file.path)) return [{ path: file.path, op: file.op, outcome: file.op === "delete" ? "delete" : "upload" }];
      return [file];
    });
    return (
      <div className="servers-upload">
        <header className="servers-upload-head">
          {deployment
            ? <p className="servers-banner ok" role="status"><CheckCircle2 size={13} aria-hidden="true" /><span>Deployment {deployment.seq}: {deployCounts(deployment.files)} on the server.</span></p>
            : <p className="servers-banner warn" role="status"><AlertTriangle size={13} aria-hidden="true" /><span>Nothing was uploaded.</span></p>}
        </header>
        <div className="servers-upload-plan">
          {result.failed.length > 0 ? (
            <section className="servers-plan-group tone-danger" aria-label="Failed">
              <h3 className="servers-group-head"><AlertTriangle size={12} aria-hidden="true" />Failed <span className="servers-count">{result.failed.length}</span></h3>
              <p className="servers-group-note">These did not go up; they stay listed as not uploaded.</p>
              <ul className="servers-files">{result.failed.map((failure) => <li key={failure.path} className="servers-file"><span className="servers-file-name">{failure.path}<small>{failure.message}</small></span></li>)}</ul>
            </section>
          ) : null}
          <PlanGroups files={files} kept={[]} force={new Set()} done canResolve={canResolve} busy={resolving} onOpen={onOpen} onResolve={resolve} onForce={() => undefined} />
        </div>
        <footer className="servers-upload-bar">
          <button type="button" className="chrome-button" onClick={() => setStage({ kind: "choose" })}>Done</button>
        </footer>
      </div>
    );
  }

  const shown = stage.preview;
  const busy = stage.kind === "uploading" || resolving;
  const summary = shown ? planSummary(shown.files.map((file) => ({ ...file, ...(force.has(file.path) ? { forced: true } : {}) }))) : undefined;
  return (
    <div className="servers-upload">
      <header className="servers-upload-head">
        <button type="button" className="icon-button" aria-label="Back to the list" onClick={cancel}><ArrowLeft size={14} /></button>
        <h2>Upload preview</h2>
      </header>
      <div className="servers-upload-plan" aria-busy={!shown}>
        {stage.kind === "preview" && stage.error ? <p className="servers-error" role="alert">{stage.error}</p>
          : !shown ? <><p className="servers-group-note">Reading the chosen files on the server…</p><Skeleton shape="block" /></>
          : (
            <>
              {shown.checkout ? <p className="servers-upload-source">Upload from <strong>{shown.checkout.branch ?? "detached HEAD"}</strong>{shown.checkout.head ? <code>{shown.checkout.head.slice(0, 8)}</code> : null}</p> : null}
              {shown.folder?.weak ? <section className="servers-folder-warning" aria-label="Check server folder"><h3>This server folder looks different from your project</h3><p>{shown.folder.listing.matches} of {shown.folder.listing.localItems} local names appear in <code>{shown.folder.listing.root}</code>. Tau has only listed this folder.</p><p className="servers-group-note">{shown.folder.listing.entries.slice(0, 12).map((entry) => `${entry.name}${entry.directory ? "/" : ""}`).join(" · ")}</p><div className="servers-folder-footer"><button type="button" className="chrome-button" onClick={() => setFolderPicker(true)}>Choose folder</button><button type="button" className="text-button" onClick={() => { const files = stage.kind === "preview" ? stage.files : []; void parts.host.invoke("confirm-server-folder", { cwd, targetId }).then(() => preview(files), (failure: unknown) => actions.notify(errorMessage(failure), "error")); }}>This is intentional</button></div></section> : null}
              {shown.warnings.map((warning) => <p key={warning} className="servers-banner warn" role="note"><AlertTriangle size={13} aria-hidden="true" /><span>{warning}</span></p>)}
              <PlanGroups files={shown.files} kept={shown.kept} force={force} canResolve={canResolve} busy={busy} onOpen={onOpen} onResolve={resolve} onForce={setForced} />
            </>
          )}
      </div>
      <footer className="servers-upload-bar">
        <button type="button" className="chrome-button" onClick={cancel}>{stage.kind === "uploading" ? stopping ? "Stopping…" : "Stop" : "Cancel"}</button>
        <button
          type="button"
          className="chrome-button primary"
          disabled={!shown || busy || !canDeploy || target.state === "incomplete" || (summary?.changed ?? 0) + (summary?.deleted ?? 0) === 0}
          onClick={() => { if (shown) upload(shown); }}
        >{stage.kind === "uploading" ? "Uploading…" : summary?.label ?? "Upload"}</button>
      </footer>
    </div>
  );
}
