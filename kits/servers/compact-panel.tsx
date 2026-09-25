import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Download, RefreshCw, Server, SquareTerminal } from "lucide-react";
import { DiffView, Empty, READ_ONLY_REASON, Skeleton, Spinner, errorMessage, tooltipProps, useWorkbenchShell, type PanelProps, type UiFileDiff } from "tau";
import { STATE_LABELS, ago, statusSentence } from "./status-model.js";
import { StatusDot, useServersStatus } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";
import { HistoryPanel } from "./history-panel.js";
import { ServerGitLine, progressWords, useTargetActions, type ServerViewParts } from "./server-view.js";
import { UploadPanel } from "./upload-panel.js";
import type { ServerDiffSource, TargetStatus } from "./view-protocol.js";
import { worstState } from "./status-model.js";

/** The thread's project on a compact client; outside the workbench there is none. */
export function useThreadCwd(): string | undefined {
  try {
    return useWorkbenchShell().snapshot?.cwd;
  } catch {
    return undefined;
  }
}

/** The sheet's glyph in the title bar, with the project's worst state as a dot. */
export function createCompactGlyph(store: ServersStatusStore) {
  return function ServersGlyph({ size = 16 }: { size?: number }) {
    const { status } = useServersStatus(store, useThreadCwd());
    const state = worstState((status?.targets ?? []).map((target) => target.state));
    return <span className="servers-glyph"><Server size={size} />{state ? <StatusDot state={state} /> : null}</span>;
  };
}

function CompactDiff({ parts, cwd, targetId, source }: { parts: ServerViewParts; cwd: string; targetId: string; source: ServerDiffSource }) {
  const key = JSON.stringify(source);
  const [loaded, setLoaded] = useState<{ key: string; diff?: UiFileDiff; error?: string }>();
  useEffect(() => {
    let live = true;
    parts.host.invoke("server-diff", { cwd, targetId, ...(JSON.parse(key) as ServerDiffSource) }).then(
      (diff) => { if (live) setLoaded({ key, diff: diff as UiFileDiff }); },
      (failure: unknown) => { if (live) setLoaded({ key, error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [parts.host, cwd, targetId, key]);
  const shown = loaded?.key === key ? loaded : undefined;
  if (shown?.error) return <p className="servers-error" role="alert">{shown.error}</p>;
  return <div className="servers-compact-diff"><DiffView key={key} {...(shown?.diff ? { diff: shown.diff } : {})} mode="unified" path={source.path} /></div>;
}

type Section = "pending" | "drift" | "history";

function CompactTarget({ parts, cwd, target, actions }: { parts: ServerViewParts; cwd: string; target: TargetStatus; actions: PanelProps["actions"] }) {
  const act = useTargetActions(parts, actions, cwd, target);
  const [open, setOpen] = useState<Section | undefined>(target.pendingTotal > 0 ? "pending" : undefined);
  const [diff, setDiff] = useState<ServerDiffSource>();
  // An upload's preview and result stay on screen although nothing is left to upload.
  const [uploading, setUploading] = useState(false);
  const same = (next: ServerDiffSource) => JSON.stringify(next) === JSON.stringify(diff);
  const show = (next: ServerDiffSource) => setDiff(same(next) ? undefined : next);
  const shownDiff = diff ? <CompactDiff parts={parts} cwd={cwd} targetId={target.targetId} source={diff} /> : null;
  const toggle = (section: Section) => setOpen((current) => (current === section ? undefined : section));
  const drift = target.drift?.length ?? 0;
  return (
    <section className="servers-compact-target" aria-label={`Server ${target.label}`}>
      <header className="servers-compact-head">
        <StatusDot state={target.state} checking={target.checking} />
        <div className="servers-compact-name">
          <h2>{target.label}</h2>
          <span className="servers-compact-state">{target.checking ? "Checking…" : STATE_LABELS[target.state]}</span>
        </div>
      </header>
      <p className="servers-compact-sentence">{statusSentence(target)}</p>
      <p className="servers-compact-meta">
        <code>{target.address}</code>
        <span>{target.mirror ? `Read ${ago(target.mirror.at)}` : "Not read yet"}{target.checkedAt ? ` · checked ${ago(target.checkedAt)}` : ""}</span>
        <ServerGitLine git={target.serverGit} />
      </p>
      {target.error ? <p className="servers-banner warn" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>{target.error}</span></p> : null}
      <div className="servers-compact-actions">
        <button type="button" className="chrome-button" disabled={act.busy !== undefined || target.checking || target.state === "unusable"} onClick={act.check}>
          {target.checking || act.busy === "check" ? <Spinner size="xs" /> : <RefreshCw size={16} aria-hidden="true" />}Check
        </button>
        {!target.mirror && target.state !== "unusable" ? (
          <button type="button" className="chrome-button" disabled={!act.canDownload || act.busy !== undefined} {...(act.canDownload ? {} : tooltipProps(READ_ONLY_REASON))} onClick={act.download}>
            <Download size={16} aria-hidden="true" />{act.busy === "download" ? progressWords(act.progress) : "Download"}
          </button>
        ) : null}
        {act.sshOnly ? (
          <button type="button" className="chrome-button" disabled={!act.canTerminal || act.busy !== undefined} {...(act.canTerminal ? {} : tooltipProps(READ_ONLY_REASON))} onClick={act.terminal}>
            <SquareTerminal size={16} aria-hidden="true" />SSH
          </button>
        ) : null}
      </div>
      {!act.canDownload ? <p className="servers-compact-note">{READ_ONLY_REASON}</p> : null}
      {target.mirror ? (
        <div className="servers-compact-sections">
          <button type="button" className="servers-compact-toggle" aria-expanded={open === "pending"} onClick={() => toggle("pending")}>
            <ChevronRight size={14} className="chev" aria-hidden="true" />Not uploaded<span className="servers-count">{target.pendingTotal}</span>
          </button>
          {open === "pending" ? (target.pendingTotal === 0 && target.withheld.length === 0 && !uploading
            ? <p className="servers-empty-line">Nothing to upload.</p>
            : <>
              <UploadPanel parts={parts} actions={actions} cwd={cwd} target={target} {...(diff?.source === "pending" ? { active: diff.path } : {})} onOpen={(path) => show({ source: "pending", path })} onHolding={setUploading} />
              {diff?.source === "pending" ? shownDiff : null}
            </>) : null}
          {drift > 0 ? (
            <>
              <button type="button" className="servers-compact-toggle" aria-expanded={open === "drift"} onClick={() => toggle("drift")}>
                <ChevronRight size={14} className="chev" aria-hidden="true" />Changed on the server<span className="servers-count">{drift}</span>
              </button>
              {open === "drift" ? (
                <ul className="servers-files">
                  {target.drift!.map((row) => <li key={row.path} className={`servers-file${target.conflicts.includes(row.path) ? " conflict" : ""}`}><span className={`servers-change ${row.change}`} aria-hidden="true">{row.change === "added" ? "A" : row.change === "deleted" ? "D" : "M"}</span><span className="servers-file-name">{row.path}</span></li>)}
                </ul>
              ) : null}
            </>
          ) : null}
          <button type="button" className="servers-compact-toggle" aria-expanded={open === "history"} onClick={() => toggle("history")}>
            <ChevronRight size={14} className="chev" aria-hidden="true" />History
          </button>
          {open === "history" ? (
            <HistoryPanel
              stacked
              parts={parts}
              actions={actions}
              cwd={cwd}
              target={target}
              active={diff?.source === "history" ? diff : undefined}
              onFile={(entry, path) => show({ source: "history", commit: entry.commit, path })}
              main={diff?.source === "history" ? shownDiff : null}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A phone's or tablet's servers: status, upload, history and rollback, with
 * touch-sized targets. Upload and rollback show their preview first and write
 * only on its button; a Read-only device sees them disabled with the reason.
 */
export function createCompactPanel(parts: ServerViewParts) {
  return function ServersSheet({ actions }: PanelProps) {
    const cwd = useThreadCwd();
    const entry = useServersStatus(parts.store, cwd, { fresh: true });
    if (!cwd) return <Empty icon={<Server size={18} />} title="No project open" description="Open a thread in a project to see its servers." />;
    if (entry.error && !entry.status) return <Empty icon={<AlertTriangle size={18} />} title="Could not read the server status" description={entry.error} />;
    if (!entry.status) return <div className="servers-compact" aria-busy="true"><Skeleton shape="card" /></div>;
    if (entry.status.targets.length === 0) return <Empty icon={<Server size={18} />} title="No servers" description="This project's .vscode/sftp.json names no server." />;
    return (
      <div className="servers-compact">
        {entry.status.targets.map((target) => <CompactTarget key={target.targetId} parts={parts} cwd={cwd} target={target} actions={actions} />)}
      </div>
    );
  };
}
