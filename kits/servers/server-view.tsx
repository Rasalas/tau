import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, GitBranch, KeyRound, RefreshCw, Server, Settings2, SquareTerminal } from "lucide-react";
import {
  DiffView, Empty, READ_ONLY_REASON, Skeleton, Spinner, errorMessage, tooltipProps, useCommandAllowed,
  type HostExtensionClient, type StageTabHandle, type UiFileDiff, type WorkbenchActions,
} from "tau";
import { DriftPanel, type DriftFeed } from "./drift-view.js";
import { HistoryPanel } from "./history-panel.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { STATE_LABELS, ago, statusSentence } from "./status-model.js";
import { StatusDot, openTarget, useServersStatus, type TargetTabParams } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";
import { UploadPanel } from "./upload-panel.js";
import { SYNC_PROGRESS_EVENT, SYNC_PROGRESS_TOPIC, type SyncProgress } from "./sync/protocol.js";
import { SERVERS_SETTINGS_PAGE, type ServerDiffSource, type ServerGitInfo, type TargetStatus } from "./view-protocol.js";

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

/** Actions a view offers on a target: check the server, log in to it, read it the first time. */
export function useTargetActions(parts: ServerViewParts, actions: WorkbenchActions, cwd: string, target: TargetStatus | undefined) {
  const [busy, setBusy] = useState<"check" | "download" | "terminal" | "git">();
  const [progress, setProgress] = useState<SyncProgress>();
  const canDownload = useCommandAllowed(SERVERS_EXTENSION_ID, "download");
  const canTerminal = useCommandAllowed(SERVERS_EXTENSION_ID, "ssh-terminal");
  const canLink = useCommandAllowed(SERVERS_EXTENSION_ID, "link-folder");
  const targetId = target?.targetId;
  const run = useCallback((kind: "check" | "download" | "terminal" | "git", step: () => Promise<unknown>) => {
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
  /** A folder with sftp.json and no Git: commit 1 is the server state, the files stay as they are (I08's `link-folder`). */
  const makeGit = () => {
    if (!targetId) return;
    run("git", async () => {
      const made = await parts.host.invoke("link-folder", { path: cwd, exclude: {}, download: false }) as { commit: string; files: number; branch: string };
      actions.notify(`Git made: ${made.files} files of the server state on ${made.branch} (${made.commit.slice(0, 7)}). git status shows your local changes.`);
      await parts.store.load(cwd, true);
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
  return { busy, progress, check, download, terminal, makeGit, canDownload, canTerminal, canLink, sshOnly };
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
  const act = useTargetActions(parts, actions, cwd, target);

  useEffect(() => { handle.setTitle(target ? `Server · ${target.label}` : "Server"); }, [handle, target?.label]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <button role="tab" aria-selected={tab === "drift"} className={tab === "drift" ? "active" : ""} onClick={() => setTab("drift")}>Changed on the server{driftCount > 0 ? ` ${driftCount}` : ""}</button>
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
        </div>
      </nav>

      <div className="servers-body">
        {tab === "pending" ? (
          !target.mirror && !entry.status.repository ? (
            <Empty icon={<GitBranch size={18} />} title="This folder has no Git yet" description="Tau reads the server and makes its state the first commit, without touching your files. Git then shows exactly what differs here from the server.">
              <button
                type="button"
                className="chrome-button primary"
                disabled={!act.canLink || act.busy !== undefined || target.state === "unusable"}
                {...(act.canLink ? {} : tooltipProps(READ_ONLY_REASON))}
                onClick={act.makeGit}
              >{act.busy === "git" ? "Reading the server…" : "Make Git from the server state"}</button>
            </Empty>
          ) : !target.mirror ? (
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
                <UploadPanel parts={parts} actions={actions} cwd={cwd} target={target} {...(pendingDiff ? { active: pendingDiff.path } : {})} onOpen={(path) => setDiff({ source: "pending", path })} />
              </aside>
              <main className="servers-main"><FileDiff host={parts.host} cwd={cwd} targetId={target.targetId} source={pendingDiff} /></main>
            </div>
          )
        ) : null}
        {tab === "drift" ? <DriftPanel context={{ host: parts.host }} feed={parts.drift} cwd={cwd} targetId={target.targetId} /> : null}
        {tab === "history" ? (
          <HistoryPanel
            parts={parts}
            actions={actions}
            cwd={cwd}
            target={target}
            active={historyDiff}
            onFile={(item, path) => setDiff({ source: "history", commit: item.commit, path })}
            main={<FileDiff host={parts.host} cwd={cwd} targetId={target.targetId} source={historyDiff} />}
          />
        ) : null}
      </div>
    </div>
  );
}
