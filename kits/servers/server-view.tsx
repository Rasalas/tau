import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, Download, GitBranch, History, KeyRound, RefreshCw, Server, Settings2, SquareTerminal } from "lucide-react";
import {
  DiffView, Empty, READ_ONLY_REASON, Skeleton, Spinner, errorMessage, tooltipProps, useCommandAllowed,
  type HostExtensionClient, type StageTabHandle, type UiFileDiff, type WorkbenchActions,
} from "tau";
import { PendingList } from "./pending-list.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { STATE_LABELS, ago, statusSentence } from "./status-model.js";
import { StatusDot, openTarget, useServersStatus, type TargetTabParams } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";
import { SYNC_PROGRESS_EVENT, SYNC_PROGRESS_TOPIC, type SyncProgress } from "./sync/protocol.js";
import { SERVERS_SETTINGS_PAGE, type HistoryEntry, type ServerDiffSource, type ServerGitInfo, type ServerHistory, type TargetStatus } from "./view-protocol.js";

/** Terminal Kit's `tau.terminal/run`, named here: a kit never imports another. */
export const TERMINAL_RUN_SERVICE = "tau.terminal/run";
export interface TerminalRunService {
  run(request: { command: string; label?: string }, actions?: WorkbenchActions): Promise<{ id: string; exitCode?: number }>;
}

export interface ServerViewParts {
  store: ServersStatusStore;
  host: HostExtensionClient;
  terminal(): TerminalRunService | undefined;
}

type Tab = "pending" | "drift" | "history";

/** One file's diff, loaded when it is chosen. */
function FileDiff({ host, cwd, targetId, source }: { host: HostExtensionClient; cwd: string; targetId: string; source: ServerDiffSource | undefined }) {
  const [loaded, setLoaded] = useState<{ key: string; diff?: UiFileDiff; error?: string }>();
  const key = source ? JSON.stringify(source) : "";
  useEffect(() => {
    if (!source) return;
    let live = true;
    host.invoke("server-diff", { cwd, targetId, ...source }).then(
      (diff) => { if (live) setLoaded({ key, diff: diff as UiFileDiff }); },
      (failure: unknown) => { if (live) setLoaded({ key, error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [host, cwd, targetId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!source) return <p className="servers-empty-line">Choose a file to see what changed.</p>;
  const shown = loaded?.key === key ? loaded : undefined;
  if (shown?.error) return <p className="servers-error" role="alert">{shown.error}</p>;
  return <DiffView key={key} {...(shown?.diff ? { diff: shown.diff } : {})} mode="unified" path={source.path} />;
}

export function ServerGitLine({ git }: { git: ServerGitInfo | undefined }) {
  if (!git) return null;
  if (!git.repository) return <span className="servers-git muted"><GitBranch size={12} aria-hidden="true" />{git.reason}</span>;
  const last = git.commits[0];
  const tip = [
    git.upstream ? `Tracks ${git.upstream}${git.ahead ? `, ${git.ahead} ahead` : ""}${git.behind ? `, ${git.behind} behind` : ""}` : "",
    git.files.length ? `Changed on the server:\n${git.files.map((file) => `${file.code} ${file.path}`).join("\n")}` : "",
    git.commits.length ? `Recent commits:\n${git.commits.slice(0, 8).map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return (
    <span className="servers-git" {...(tip ? tooltipProps(tip, { variant: "lines" }) : {})}>
      <GitBranch size={12} aria-hidden="true" />
      <span>Server Git: {git.branch ?? "detached"}</span>
      <span>{git.changed === 0 ? "clean" : `${git.changed} uncommitted`}</span>
      {last ? <span className="servers-git-commit">{last.sha.slice(0, 7)} {last.subject}</span> : null}
    </span>
  );
}

function DriftList({ target }: { target: TargetStatus }) {
  const rows = target.drift ?? [];
  if (rows.length === 0) return <Empty size="compact" icon={<Server size={16} />} title="No changes on the server" description={`The server matched the mirror state when Tau last checked, ${ago(target.checkedAt)}.`} />;
  return (
    <div className="servers-drift">
      <p className="servers-group-note">Changed on the server since Tau last read it{target.driftMethod ? ` (listed ${target.driftMethod === "shell" ? "with the server's shell" : "over SFTP"})` : ""}. Your local files are untouched.</p>
      <ul className="servers-files">
        {rows.map((row) => (
          <li key={row.path} className={`servers-file${target.conflicts.includes(row.path) ? " conflict" : ""}`}>
            <span className={`servers-change ${row.change}`} aria-hidden="true">{row.change === "added" ? "A" : row.change === "deleted" ? "D" : "M"}</span>
            <span className="servers-file-name">{row.path}</span>
            {target.conflicts.includes(row.path) ? <span className="servers-tag danger">changed here too</span> : null}
            {row.certain ? null : <span className="servers-tag" {...tooltipProps("Only size and time differ; the server could not hash it.")}>likely</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryList({ entries, active, onFile }: { entries: readonly HistoryEntry[]; active: ServerDiffSource | undefined; onFile(entry: HistoryEntry, path: string): void }) {
  const [open, setOpen] = useState<string | undefined>(entries[0]?.commit);
  return (
    <ol className="servers-history" aria-label="History">
      {entries.map((entry) => {
        const expanded = open === entry.commit;
        const counts = [entry.added ? `${entry.added} new` : "", entry.modified ? `${entry.modified} changed` : "", entry.deleted ? `${entry.deleted} deleted` : ""].filter(Boolean).join(" · ") || "no changes";
        const first = !entry.parent;
        return (
          <li key={entry.commit} className="servers-history-entry">
            <button type="button" className="servers-history-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : entry.commit)}>
              <ChevronRight size={12} className="chev" aria-hidden="true" />
              <span className="servers-history-title">{entry.kind === "read" ? (first ? "First read of the server" : "Read from the server") : entry.subject}</span>
              <time dateTime={entry.at} {...tooltipProps(new Date(entry.at).toLocaleString())}>{ago(entry.at)}</time>
            </button>
            <p className="servers-history-meta">{first ? `${entry.added} files` : counts}</p>
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
  );
}

/** Actions a view offers on a target: check the server, log in to it, read it the first time. */
export function useTargetActions(parts: ServerViewParts, actions: WorkbenchActions, cwd: string, target: TargetStatus | undefined) {
  const [busy, setBusy] = useState<"check" | "download" | "terminal">();
  const [progress, setProgress] = useState<SyncProgress>();
  const canDownload = useCommandAllowed(SERVERS_EXTENSION_ID, "download");
  const canTerminal = useCommandAllowed(SERVERS_EXTENSION_ID, "ssh-terminal");
  const targetId = target?.targetId;
  const run = useCallback((kind: "check" | "download" | "terminal", step: () => Promise<unknown>) => {
    setBusy(kind);
    step().catch((failure: unknown) => actions.notify(errorMessage(failure))).finally(() => { setBusy(undefined); setProgress(undefined); });
  }, [actions]);
  const check = () => { if (targetId) run("check", () => parts.store.check(cwd, targetId)); };
  const download = () => {
    if (!targetId) return;
    run("download", async () => {
      const unwatch = parts.host.watch?.(SYNC_PROGRESS_TOPIC);
      const unlisten = parts.host.onEvent(SYNC_PROGRESS_EVENT, (payload) => {
        const next = payload as SyncProgress;
        if (next.targetId === targetId) setProgress(next);
      });
      try {
        await parts.host.invoke("download", { cwd, targetId });
      } finally {
        unlisten();
        unwatch?.();
      }
      await parts.store.check(cwd, targetId);
    });
  };
  const terminal = () => {
    if (!targetId || !target) return;
    const service = parts.terminal();
    if (!service) { actions.notify("The SSH terminal needs Terminal Kit, which is off."); return; }
    run("terminal", async () => {
      const { command } = await parts.host.invoke("ssh-terminal", { cwd, targetId }) as { command: string };
      void service.run({ command, label: `ssh ${target.label}` }, actions);
    });
  };
  const sshOnly = target?.protocol === "sftp" && target.state !== "unusable";
  return { busy, progress, check, download, terminal, canDownload, canTerminal, sshOnly };
}

export function progressWords(progress: SyncProgress | undefined): string {
  if (!progress) return "Starting…";
  if (progress.phase === "connect") return "Connecting…";
  if (progress.phase === "list") return `Listing the server… ${progress.done} files`;
  if (progress.phase === "fetch") return `Downloading ${progress.done} of ${progress.total ?? "?"} files…`;
  if (progress.phase === "record") return "Recording the mirror state…";
  return "Finishing…";
}

/**
 * A server target on the stage: its state and the server's own Git, the
 * files an upload would take (with the diff of each against the mirror
 * state), what changed on the server, and the recorded states.
 */
export default function ServerView({ params, handle, actions, parts }: { params: TargetTabParams; handle: StageTabHandle; actions: WorkbenchActions; parts: ServerViewParts }) {
  const cwd = params.workspace;
  const entry = useServersStatus(parts.store, cwd, { fresh: true });
  const target = entry.status?.targets.find((candidate) => candidate.targetId === params.targetId);
  const [tab, setTab] = useState<Tab>("pending");
  const [diff, setDiff] = useState<ServerDiffSource>();
  const [history, setHistory] = useState<{ entries?: HistoryEntry[]; error?: string }>({});
  const act = useTargetActions(parts, actions, cwd, target);

  useEffect(() => { handle.setTitle(target ? `Server · ${target.label}` : "Server"); }, [handle, target?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const mirrorCommit = target?.mirror?.commit;
  useEffect(() => {
    if (tab !== "history") return;
    let live = true;
    parts.host.invoke("server-history", { cwd, targetId: params.targetId }).then(
      (value) => { if (live) setHistory({ entries: (value as ServerHistory).entries }); },
      (failure: unknown) => { if (live) setHistory({ error: errorMessage(failure) }); },
    );
    return () => { live = false; };
  }, [tab, cwd, params.targetId, mirrorCommit, parts.host]);
  useEffect(() => { if (tab === "drift" && !target?.drift?.length) setTab("pending"); }, [tab, target?.drift?.length]);

  if (entry.error && !target) return <div className="servers-view"><Empty icon={<AlertTriangle size={18} />} title="Could not read the server status" description={entry.error} /></div>;
  if (!entry.status) return <div className="servers-view" aria-busy="true"><Skeleton shape="card" /></div>;
  if (!target) {
    return <div className="servers-view"><Empty icon={<Server size={18} />} title="This server is gone" description="The project's sftp.json no longer names it.">
      <button type="button" className="chrome-button" onClick={() => actions.openSettings(SERVERS_SETTINGS_PAGE)}>Open Settings → Servers</button>
    </Empty></div>;
  }

  const others = entry.status.targets.filter((candidate) => candidate.targetId !== target.targetId);
  const driftCount = target.drift?.length ?? 0;
  const firstPending = target.pending[0]?.path;
  const pendingDiff = diff?.source === "pending" ? diff : firstPending ? { source: "pending" as const, path: firstPending } : undefined;
  const historyDiff = diff?.source === "history" ? diff : undefined;
  const readOnlyTip = (allowed: boolean, tip: string) => tooltipProps(allowed ? tip : READ_ONLY_REASON);

  return (
    <div className="servers-view" aria-label={`Server ${target.label}`}>
      <header className="servers-head">
        <div className="servers-head-row">
          <Server size={15} aria-hidden="true" />
          <h1 className="servers-title">{target.label}</h1>
          {target.profile ? <span className="servers-tag">{target.profile}</span> : null}
          <span className={`servers-state tone-${target.state}`}><StatusDot state={target.state} checking={target.checking} />{target.checking ? "Checking…" : STATE_LABELS[target.state]}</span>
          <span className="spacer" />
          {others.length > 0 ? (
            <select className="settings-select servers-switch" aria-label="Another server of this project" value="" onChange={(event) => { if (event.target.value) openTarget(actions, cwd, event.target.value); }}>
              <option value="">Other servers…</option>
              {others.map((other) => <option key={other.targetId} value={other.targetId}>{other.label} · {STATE_LABELS[other.state]}</option>)}
            </select>
          ) : null}
          <button type="button" className="icon-button" aria-label="Check the server" disabled={act.busy !== undefined || target.checking || target.state === "unusable"} {...tooltipProps("Check the server")} onClick={act.check}>
            {target.checking || act.busy === "check" ? <Spinner size="xs" /> : <RefreshCw size={14} />}
          </button>
          {act.sshOnly ? (
            <button type="button" className="icon-button" aria-label="Open an SSH terminal" disabled={!act.canTerminal || act.busy !== undefined} {...readOnlyTip(act.canTerminal, "Open an SSH terminal in the server folder")} onClick={act.terminal}>
              <SquareTerminal size={14} />
            </button>
          ) : null}
          <button type="button" className="icon-button" aria-label="Server settings" {...tooltipProps("Settings → Servers")} onClick={() => actions.openSettings(SERVERS_SETTINGS_PAGE)}>
            <Settings2 size={14} />
          </button>
        </div>
        <div className="servers-head-meta">
          <code {...tooltipProps(target.address, { variant: "code" })}>{target.address}</code>
          <span>{target.context ? <>Local folder <code>{target.context}</code></> : "The project folder"}</span>
          {target.mirror ? <span {...tooltipProps(new Date(target.mirror.at).toLocaleString())}>Read {ago(target.mirror.at)}</span> : null}
          {target.checkedAt ? <span {...tooltipProps(new Date(target.checkedAt).toLocaleString())}>Checked {ago(target.checkedAt)}</span> : null}
          <ServerGitLine git={target.serverGit} />
        </div>
        {target.state === "unreachable" ? (
          <p className="servers-banner danger" role="alert">
            <AlertTriangle size={13} aria-hidden="true" /><span>{statusSentence(target)}</span>
            <button type="button" className="text-button" disabled={act.busy !== undefined || target.checking} onClick={act.check}>Try again</button>
          </p>
        ) : null}
        {target.state === "unusable" ? <p className="servers-banner danger" role="alert"><AlertTriangle size={13} aria-hidden="true" /><span>{statusSentence(target)}</span></p> : null}
        {target.error ? <p className="servers-banner warn" role="status"><AlertTriangle size={13} aria-hidden="true" /><span>{target.error}</span></p> : null}
        {target.liveConfigs.length > 0 ? (
          <p className="servers-banner warn" role="note">
            <KeyRound size={13} aria-hidden="true" />
            <span>Live credentials on the server: {target.liveConfigs.map((config) => `${config.path} (${config.label})`).join(", ")}. An upload leaves a change to them out unless you choose it.</span>
          </p>
        ) : null}
      </header>

      <nav className="servers-tabs">
        <div className="toggle-group" role="tablist" aria-label="Server sections">
          <button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>Not uploaded {target.pendingTotal}</button>
          {driftCount > 0 ? <button role="tab" aria-selected={tab === "drift"} className={tab === "drift" ? "active" : ""} onClick={() => setTab("drift")}>Changed on the server {driftCount}</button> : null}
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
        </div>
      </nav>

      <div className="servers-body">
        {tab === "pending" ? (
          !target.mirror ? (
            <Empty icon={<Download size={18} />} title="Tau has not read this server yet" description="Download the server's files once: Tau keeps them as the mirror state, compares your local copy with it and keeps local files that differ.">
              <button
                type="button"
                className="chrome-button primary"
                disabled={!act.canDownload || act.busy !== undefined || target.state === "unusable"}
                {...(act.canDownload ? {} : tooltipProps(READ_ONLY_REASON))}
                onClick={act.download}
              >{act.busy === "download" ? progressWords(act.progress) : "Download the server state"}</button>
            </Empty>
          ) : target.pendingTotal === 0 && target.withheld.length === 0 ? (
            <Empty icon={<Server size={18} />} title="Nothing to upload" description={`Your local copy matches the server as Tau last read it, ${ago(target.mirror.at)}.`} />
          ) : (
            <div className="servers-split">
              <aside className="servers-aside" aria-label="Files not uploaded">
                <PendingList rows={target.pending} total={target.pendingTotal} withheld={target.withheld} {...(pendingDiff ? { active: pendingDiff.path } : {})} onOpen={(path) => setDiff({ source: "pending", path })} />
              </aside>
              <main className="servers-main"><FileDiff host={parts.host} cwd={cwd} targetId={target.targetId} source={pendingDiff} /></main>
            </div>
          )
        ) : null}
        {tab === "drift" ? <DriftList target={target} /> : null}
        {tab === "history" ? (
          history.error ? <p className="servers-error" role="alert">{history.error}</p>
            : !history.entries ? <Skeleton shape="card" />
            : history.entries.length === 0 ? <Empty icon={<History size={18} />} title="No history yet" description="Each read of the server, and later each upload, is recorded here." />
            : (
              <div className="servers-split">
                <aside className="servers-aside"><HistoryList entries={history.entries} active={historyDiff} onFile={(item, path) => setDiff({ source: "history", commit: item.commit, path })} /></aside>
                <main className="servers-main"><FileDiff host={parts.host} cwd={cwd} targetId={target.targetId} source={historyDiff} /></main>
              </div>
            )
        ) : null}
      </div>
    </div>
  );
}
