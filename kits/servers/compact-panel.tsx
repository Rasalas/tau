import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Download, RefreshCw, Server, SquareTerminal } from "lucide-react";
import { DiffView, Empty, READ_ONLY_REASON, Skeleton, Spinner, errorMessage, tooltipProps, useWorkbenchShell, type PanelProps, type UiFileDiff } from "tau";
import { PendingList } from "./pending-list.js";
import { STATE_LABELS, ago, statusSentence } from "./status-model.js";
import { StatusDot, useServersStatus } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";
import { ServerGitLine, progressWords, useTargetActions, type ServerViewParts } from "./server-view.js";
import type { HistoryEntry, ServerHistory, TargetStatus } from "./view-protocol.js";
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

function CompactHistory({ parts, cwd, target }: { parts: ServerViewParts; cwd: string; target: TargetStatus }) {
  const [history, setHistory] = useState<{ entries?: HistoryEntry[]; error?: string }>({});
  useEffect(() => {
    let live = true;
    parts.host.invoke("server-history", { cwd, targetId: target.targetId }).then(
      (value) => { if (live) setHistory({ entries: (value as ServerHistory).entries }); },
      (failure: unknown) => { if (live) setHistory({ error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [parts.host, cwd, target.targetId, target.mirror?.commit]);
  if (history.error) return <p className="servers-error" role="alert">{history.error}</p>;
  if (!history.entries) return <Skeleton shape="block" />;
  if (history.entries.length === 0) return <p className="servers-empty-line">No history yet.</p>;
  return (
    <ol className="servers-history compact">
      {history.entries.map((entry) => (
        <li key={entry.commit} className="servers-history-entry">
          <span className="servers-history-title">{entry.kind === "read" ? (entry.parent ? "Read from the server" : "First read of the server") : entry.subject}</span>
          <time dateTime={entry.at}>{ago(entry.at)}</time>
          <p className="servers-history-meta">{entry.parent ? [entry.added ? `${entry.added} new` : "", entry.modified ? `${entry.modified} changed` : "", entry.deleted ? `${entry.deleted} deleted` : ""].filter(Boolean).join(" · ") || "no changes" : `${entry.added} files`}</p>
        </li>
      ))}
    </ol>
  );
}

function CompactDiff({ parts, cwd, targetId, path }: { parts: ServerViewParts; cwd: string; targetId: string; path: string }) {
  const [loaded, setLoaded] = useState<{ path: string; diff?: UiFileDiff; error?: string }>();
  useEffect(() => {
    let live = true;
    parts.host.invoke("server-diff", { cwd, targetId, source: "pending", path }).then(
      (diff) => { if (live) setLoaded({ path, diff: diff as UiFileDiff }); },
      (failure: unknown) => { if (live) setLoaded({ path, error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [parts.host, cwd, targetId, path]);
  const shown = loaded?.path === path ? loaded : undefined;
  if (shown?.error) return <p className="servers-error" role="alert">{shown.error}</p>;
  return <div className="servers-compact-diff"><DiffView key={path} {...(shown?.diff ? { diff: shown.diff } : {})} mode="unified" path={path} /></div>;
}

type Section = "pending" | "drift" | "history";

function CompactTarget({ parts, cwd, target, actions }: { parts: ServerViewParts; cwd: string; target: TargetStatus; actions: PanelProps["actions"] }) {
  const act = useTargetActions(parts, actions, cwd, target);
  const [open, setOpen] = useState<Section | undefined>(target.pendingTotal > 0 ? "pending" : undefined);
  const [file, setFile] = useState<string>();
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
          {open === "pending" ? (target.pendingTotal === 0 && target.withheld.length === 0
            ? <p className="servers-empty-line">Nothing to upload.</p>
            : <>
              <PendingList rows={target.pending} total={target.pendingTotal} withheld={target.withheld} {...(file ? { active: file } : {})} onOpen={(path) => setFile((current) => (current === path ? undefined : path))} />
              {file ? <CompactDiff parts={parts} cwd={cwd} targetId={target.targetId} path={file} /> : null}
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
          {open === "history" ? <CompactHistory parts={parts} cwd={cwd} target={target} /> : null}
        </div>
      ) : null}
    </section>
  );
}

/** A phone's or tablet's servers: status, what is not uploaded, the history; writes only with Full access. */
export function createCompactPanel(parts: ServerViewParts) {
  return function ServersSheet({ actions }: PanelProps) {
    const cwd = useThreadCwd();
    const entry = useServersStatus(parts.store, cwd);
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
