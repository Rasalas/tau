import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Server, Settings2 } from "lucide-react";
import {
  DiffView, Empty, Skeleton, Spinner, errorMessage, tooltipProps, useCommandAllowed,
  type HostExtensionClient, type StageTabHandle, type UiFileDiff, type WorkbenchActions,
} from "tau";
import { type DriftFeed } from "./drift-view.js";
import { HistoryPanel } from "./history-panel.js";
import { ServerFolderPicker } from "./folder-picker.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { statusSentence } from "./status-model.js";
import { openTarget, useServersStatus, type TargetTabParams } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";
import { UploadPanel } from "./upload-panel.js";
import { SERVERS_SETTINGS_PAGE, type ServerDiffSource } from "./view-protocol.js";

/** Terminal Kit's `tau.terminal/run`, named here: a kit never imports another. */
export const TERMINAL_RUN_SERVICE = "tau.terminal/run";
export interface TerminalRunService {
  run(request: { command: string; label?: string }, actions?: WorkbenchActions): Promise<{ id: string; exitCode?: number }>;
}

export interface ServerViewParts {
  store: ServersStatusStore;
  host: HostExtensionClient;
  /** Server drift as the drift service keeps it: the tab shows its panel. */
  drift: DriftFeed;
  terminal(): TerminalRunService | undefined;
}

type Tab = "pending" | "history";

/** One file's diff, loaded when it is chosen. */
export function FileDiff({ host, cwd, targetId, source, onChanged, onClose }: { host: HostExtensionClient; cwd: string; targetId: string; source: ServerDiffSource | undefined; onChanged?(): void; onClose?(): void }) {
  const [loaded, setLoaded] = useState<{ key: string; diff?: UiFileDiff; error?: string }>();
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [taking, setTaking] = useState(false);
  const [undoId, setUndoId] = useState<string>();
  const mutation = useRef<string | undefined>(undefined);
  const canTake = useCommandAllowed(SERVERS_EXTENSION_ID, "deploy-resolve");
  const key = source ? JSON.stringify(source) : "";
  useEffect(() => {
    if (!source) return;
    let live = true;
    const operationId = crypto.randomUUID();
    host.invoke(source.source === "pending" ? "server-file-diff" : "server-diff", { cwd, targetId, operationId, ...source }).then(
      (diff) => { if (live) setLoaded({ key, diff: diff as UiFileDiff }); },
      (failure: unknown) => { if (live) setLoaded({ key, error: errorMessage(failure) }); },
    );
    return () => { live = false; if (source.source === "pending") void host.invoke("cancel-server-operation", { cwd, targetId, operationId }).catch(() => undefined); };
  }, [host, cwd, targetId, key, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (mutation.current) void host.invoke("cancel-server-operation", { cwd, targetId, operationId: mutation.current }).catch(() => undefined);
  }, [host, cwd, targetId]);
  if (!source) return <p className="servers-empty-line">Choose a file to see what changed.</p>;
  const shown = loaded?.key === key ? loaded : undefined;
  const take = async () => {
    setTaking(true); setConfirming(false);
    const operationId = crypto.randomUUID();
    mutation.current = operationId;
    try {
      const result = await host.invoke("deploy-resolve", { cwd, targetId, operationId, path: source.path, action: "take-server" }) as { undoId?: string };
      setUndoId(result.undoId); setRevision((current) => current + 1); onChanged?.();
    } catch (failure) { setLoaded({ key, error: errorMessage(failure) }); }
    finally { mutation.current = undefined; setTaking(false); }
  };
  const undo = async () => {
    setTaking(true);
    const operationId = crypto.randomUUID();
    mutation.current = operationId;
    try { await host.invoke("undo-server-take", { cwd, targetId, operationId, id: undoId }); setUndoId(undefined); setRevision((current) => current + 1); onChanged?.(); }
    catch (failure) { setLoaded({ key, error: errorMessage(failure) }); }
    finally { mutation.current = undefined; setTaking(false); }
  };
  return <>
    {source.source === "pending" ? <div className="servers-file-actions">
      {onClose ? <button type="button" className="text-button" onClick={onClose}>Close comparison</button> : null}
      {undoId ? <><span>Server version taken. Your previous file is backed up.</span><button type="button" className="text-button" disabled={taking || !canTake} onClick={() => void undo()}>Undo</button></> : confirming ? <><span>Replace this local file with the server version? A backup is kept in History.</span><button type="button" className="text-button" onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="chrome-button" disabled={taking || !canTake} onClick={() => void take()}>Replace local file</button></> : shown?.diff ? <button type="button" className="text-button" disabled={taking || !canTake} onClick={() => setConfirming(true)}>{taking ? "Taking server version…" : "Use server version…"}</button> : null}
    </div> : null}
    {shown?.error ? <p className="servers-error" role="alert">{shown.error}</p> : <DiffView key={`${key}:${revision}`} {...(shown?.diff ? { diff: shown.diff } : {})} mode="unified" path={source.path} />}
  </>;
}

/** Refreshing this view reads local files only. */
function useTargetActions(parts: ServerViewParts, actions: WorkbenchActions, cwd: string) {
  const [busy, setBusy] = useState<"check">();
  const check = useCallback(() => {
    setBusy("check");
    parts.store.load(cwd, true)
      .catch((failure: unknown) => actions.notify(errorMessage(failure), "error"))
      .finally(() => setBusy(undefined));
  }, [parts.store, cwd, actions]);
  return { busy, check };
}

/**
 * Upload the local checkout, inspect a chosen file, or review earlier uploads.
 */
export default function ServerView({ params, handle, actions, parts }: { params: TargetTabParams; handle: StageTabHandle; actions: WorkbenchActions; parts: ServerViewParts }) {
  const cwd = params.workspace;
  const entry = useServersStatus(parts.store, cwd, { fresh: true });
  const target = entry.status?.targets.find((candidate) => candidate.targetId === params.targetId);
  const [tab, setTab] = useState<Tab>("pending");
  const [diff, setDiff] = useState<ServerDiffSource>();
  // An upload's preview and result stay on screen although nothing is left to upload.
  const [uploading, setUploading] = useState(false);
  const [folders, setFolders] = useState(false);
  const act = useTargetActions(parts, actions, cwd);
  const canAuthorize = useCommandAllowed(SERVERS_EXTENSION_ID, "authorize-server");

  useEffect(() => { handle.setTitle(target ? `Server · ${target.label}` : "Server"); }, [handle, target?.label]); // eslint-disable-line react-hooks/exhaustive-deps

  if (entry.error && !target) return <div className="servers-view"><Empty icon={<AlertTriangle size={18} />} title="Could not read the server status" description={entry.error} /></div>;
  if (!entry.status) return <div className="servers-view" aria-busy="true"><Skeleton shape="card" /></div>;
  if (!target) {
    return <div className="servers-view"><Empty icon={<Server size={18} />} title="This server is gone" description="The project's sftp.json no longer names it.">
      <button type="button" className="chrome-button" onClick={() => actions.openSettings(SERVERS_SETTINGS_PAGE)}>Open Settings → Servers</button>
    </Empty></div>;
  }

  const others = entry.status.targets.filter((candidate) => candidate.targetId !== target.targetId);
  const pendingDiff = diff?.source === "pending" ? diff : undefined;
  const historyDiff = diff?.source === "history" ? diff : undefined;
  const inspect = async (path: string) => {
    try {
      if (target.connectionFingerprint && canAuthorize) await parts.host.invoke("authorize-server", { cwd, targetId: target.targetId, fingerprint: target.connectionFingerprint });
      setDiff({ source: "pending", path });
    } catch (failure) { actions.notify(errorMessage(failure), "error"); }
  };
  let content: ReactNode;
  if (folders) {
    content = <ServerFolderPicker host={parts.host} cwd={cwd} target={target} actions={actions} onClose={() => {
      setFolders(false);
      void parts.store.load(cwd, true);
    }} />;
  } else if (tab === "history") {
    content = <HistoryPanel parts={parts} actions={actions} cwd={cwd} target={target} active={historyDiff}
      onFile={(item, path) => setDiff({ source: "history", commit: item.commit, path })}
      main={<FileDiff host={parts.host} cwd={cwd} targetId={target.targetId} source={historyDiff} />} />;
  } else if (target.pendingTotal === 0 && target.withheld.length === 0 && !uploading && !pendingDiff) {
    content = <Empty icon={<Server size={18} />} title="Nothing to upload"
      description={target.mirror
        ? "Your local files match the last known server state. The server is checked again before an upload."
        : "This local folder has no uploadable files. Check its folder mapping and exclusions."} />;
  } else {
    content = <div className={`servers-split${pendingDiff ? "" : " servers-upload-only"}`}>
      <aside className="servers-aside" aria-label="Files to upload">
        <UploadPanel key={`${target.targetId}:${entry.status.branch ?? ""}:${entry.status.head ?? ""}`}
          parts={parts} actions={actions} cwd={cwd} target={target} initialPaths={params.paths} proposedThread={params.threadId}
          {...(pendingDiff ? { active: pendingDiff.path } : {})} onOpen={(path) => void inspect(path)} onHolding={setUploading} />
      </aside>
      {pendingDiff ? <main className="servers-main">
        <FileDiff key={`${entry.status.branch}:${entry.status.head}:${pendingDiff.path}`}
          host={parts.host} cwd={cwd} targetId={target.targetId} source={pendingDiff}
          onChanged={() => void parts.store.load(cwd, true)} onClose={() => setDiff(undefined)} />
      </main> : null}
    </div>;
  }
  return (
    <div className="servers-view" aria-label={`Server ${target.label}`}>
      <header className="servers-head">
        <div className="servers-head-row">
          <Server size={15} aria-hidden="true" />
          <h1 className="servers-title">{target.label}</h1>
          {target.profile ? <span className="servers-tag">{target.profile}</span> : null}
          <span className="spacer" />
          {others.length ? <select className="settings-select servers-switch" aria-label="Another server of this project" value="" onChange={(event) => { if (event.target.value) openTarget(actions, cwd, event.target.value); }}><option value="">Other servers…</option>{others.map((other) => <option key={other.targetId} value={other.targetId}>{other.label}</option>)}</select> : null}
          <button type="button" className="icon-button" aria-label="Refresh local files" disabled={act.busy !== undefined} {...tooltipProps("Refresh local files without connecting to the server")} onClick={act.check}>{act.busy === "check" ? <Spinner size="xs" /> : <RefreshCw size={14} />}</button>
          <button type="button" className="icon-button" aria-label="Server settings" {...tooltipProps("Settings → Servers")} onClick={() => actions.openSettings(SERVERS_SETTINGS_PAGE)}><Settings2 size={14} /></button>
        </div>
        <div className="servers-head-meta"><code>{target.address}</code><button type="button" className="text-button" onClick={() => setFolders(true)}>Folders…</button></div>
        <p className="servers-upload-source">Upload from <strong>{entry.status.branch ?? "project files"}</strong>{entry.status.head ? <code>{entry.status.head.slice(0, 8)}</code> : null}{target.context ? <span> · {target.context}/</span> : null}</p>
        {target.state === "incomplete" ? <p className="servers-banner warn" role="status"><AlertTriangle size={13} /><span>An upload was interrupted. Review its backup and result before uploading again.</span><button type="button" className="text-button" onClick={() => setTab("history")}>History</button></p> : null}
        {target.state === "unusable" ? <p className="servers-error" role="alert">{statusSentence(target)}</p> : null}
        {target.error ? <p className="servers-error" role="alert">{target.error}</p> : null}
      </header>
      <nav className="servers-tabs"><div className="toggle-group" role="tablist" aria-label="Server sections"><button type="button" role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>Upload</button><button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button></div></nav>
      <div className="servers-body">{content}</div>
    </div>
  );
}
