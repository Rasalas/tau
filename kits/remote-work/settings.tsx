import { useCallback, useEffect, useState } from "react";
import { Check, Circle, FolderSync, Loader2, Minus, X } from "lucide-react";
import { Empty, READ_ONLY_REASON, SettingRow, SettingsSection, Skeleton, errorMessage, formatCost, useCommandAllowed, type HostExtensionClient, type SettingsPageProps, type UiThreadUsage } from "tau";
import {
  REMOTE_WORK_EXTENSION_ID as ID,
  THREAD_LINK_EVENT,
  TRANSFER_EVENT,
  type IgnoredCandidate,
  type IgnoredFilesView,
  type RemoteThreadLink,
  type RemoteThreadStatus,
  type RepoTransfer,
  type TransferStep,
} from "./protocol.js";

const REASONS: Record<IgnoredCandidate["reason"], string> = { env: "Environment file", issues: "Notes or issues", text: "Small text" };
const SKIPPED: Record<string, string> = { build: "dependencies or build output", large: "too large", binary: "not text", system: "system or log file" };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAge(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

const STEP_ICONS = { pending: Circle, running: Loader2, done: Check, failed: X, skipped: Minus } as const;

export function Steps({ steps }: { steps: readonly TransferStep[] }) {
  return (
    <ol className="remote-work-steps">
      {steps.map((step) => {
        const Icon = STEP_ICONS[step.state];
        return (
          <li key={step.id} className={`remote-work-step ${step.state}`} title={step.detail} aria-label={`${step.label}: ${step.state}${step.detail ? `, ${step.detail}` : ""}`}>
            <Icon size={12} aria-hidden="true" className={step.state === "running" ? "remote-work-spin" : undefined} />
            <span aria-hidden="true">{step.label}</span>
            {step.detail ? <small aria-hidden="true">{step.detail}</small> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** What a transfer's row says under its title. */
export function transferSummary(transfer: RepoTransfer): string {
  if (transfer.state === "failed") return `Failed: ${transfer.error ?? "unknown reason"}`;
  if (transfer.state === "discarded") return "Let go; the worktree there is removed";
  if (transfer.state === "sending") return `Sending to ${transfer.machineName}…`;
  if (transfer.applied) return transfer.applied.detail;
  if (transfer.result?.state === "nothing") return `Nothing changed on ${transfer.machineName} yet`;
  if (transfer.result?.state === "branch") return `${transfer.result.branch}: ${transfer.result.commits} commit${transfer.result.commits === 1 ? "" : "s"}, ${transfer.result.files} file${transfer.result.files === 1 ? "" : "s"}`;
  return `Worktree on ${transfer.machineName}: ${transfer.remote?.path ?? "ready"}`;
}

function useIgnoredFiles(host: HostExtensionClient, cwd: string | undefined) {
  const [view, setView] = useState<IgnoredFilesView>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!cwd) return undefined;
    let live = true;
    setView(undefined);
    setProblem(undefined);
    host.invoke("ignored-files", { cwd }).then((value) => { if (live) setView(value as IgnoredFilesView); }, (error: unknown) => { if (live) setProblem(errorMessage(error)); });
    return () => { live = false; };
  }, [host, cwd]);
  return { view, setView, problem, setProblem };
}

function useTransfers(host: HostExtensionClient, cwd: string | undefined, root: string | undefined) {
  const [transfers, setTransfers] = useState<RepoTransfer[]>([]);
  useEffect(() => {
    if (!cwd) return undefined;
    let live = true;
    host.invoke("transfers", { cwd }).then((value) => { if (live && Array.isArray(value)) setTransfers(value as RepoTransfer[]); }, () => undefined);
    const stop = host.onEvent(TRANSFER_EVENT, (payload) => {
      const transfer = payload as RepoTransfer;
      if (!live || !transfer?.id || (root && transfer.root !== root)) return;
      setTransfers((current) => [transfer, ...current.filter((entry) => entry.id !== transfer.id)].sort((left, right) => right.createdAt - left.createdAt));
    });
    return () => { live = false; stop(); };
  }, [host, cwd, root]);
  return transfers;
}

function TransferRow({ transfer, host, allowed, now, onNotify }: { transfer: RepoTransfer; host: HostExtensionClient; allowed: boolean; now: number; onNotify(message: string): void }) {
  const [busy, setBusy] = useState<string>();
  const run = (command: "fetch-result" | "apply" | "discard", label: string) => {
    setBusy(command);
    host.invoke(command, { transfer: transfer.id }).then((value) => {
      const next = value as RepoTransfer;
      if (command === "apply" && next.applied && next.applied.state !== "merged") onNotify(next.applied.detail);
      else onNotify(`${label}: ${transferSummary(next)}`);
    }, (error: unknown) => onNotify(errorMessage(error))).finally(() => setBusy(undefined));
  };
  const hasBranch = transfer.result?.state === "branch";
  const merged = transfer.applied?.state === "merged" || transfer.applied?.state === "already-merged";
  const ready = transfer.state === "ready";
  const files = ready ? transfer.applied?.files ?? [] : [];
  return (
    <SettingRow
      title={<>{transfer.machineName}{transfer.name ? ` · ${transfer.name}` : ""} <small className="remote-work-age">{formatAge(transfer.createdAt, now)}</small></>}
      description={<span className={`remote-work-summary ${transfer.state}`}>{transferSummary(transfer)}</span>}
      status={files.length > 0 || transfer.state === "sending" || transfer.state === "failed" ? <>
        {files.length > 0 ? <ul className="remote-work-files">{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}
        {transfer.state === "sending" || transfer.state === "failed" ? <Steps steps={transfer.steps} /> : null}
      </> : undefined}
      disabledReason={allowed ? undefined : READ_ONLY_REASON}
      control={ready ? (
        <span className="remote-work-actions">
          <button type="button" className="chrome-button" disabled={Boolean(busy) || !allowed} onClick={() => run("fetch-result", "Brought back")}>{busy === "fetch-result" ? "Bringing back…" : hasBranch ? "Bring back again" : "Bring back"}</button>
          {hasBranch && !merged ? <button type="button" className="chrome-button" disabled={Boolean(busy) || !allowed} onClick={() => run("apply", "Merged")}>{busy === "apply" ? "Merging…" : "Merge"}</button> : null}
          <button type="button" className="text-button" disabled={Boolean(busy) || !allowed} onClick={() => run("discard", "Let go")}>Let go</button>
        </span>
      ) : undefined}
    />
  );
}

const STATUS_LABELS: Record<RemoteThreadStatus, string> = {
  sending: "Sending",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting for an answer",
  idle: "Idle",
  failed: "Failed",
  gone: "Deleted there",
  offline: "Offline · may still be running",
  settled: "Settled",
};

/** Money it cost there; a subscription's share reads "plan", with what the API would have charged. */
export function remoteCost(usage: UiThreadUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const money = formatCost(usage.costUsd);
  const plan = usage.subscription && usage.subscription.totalTokens > 0 ? `plan${formatCost(usage.subscription.apiValueUsd) ? ` ≈${formatCost(usage.subscription.apiValueUsd)}` : ""}` : undefined;
  return [money, plan].filter(Boolean).join(" + ") || undefined;
}

/** What a thread link's row says under its title. */
export function threadSummary(link: RemoteThreadLink): string {
  if (link.settled) return link.settled.detail;
  if (link.applied && link.applied.state !== "merged" && link.applied.state !== "already-merged") return link.applied.detail;
  if (link.status === "failed" || link.status === "gone") return link.error ?? "It stopped there.";
  if (link.there?.question && link.status === "waiting") return `Asks: ${link.there.question}`;
  if (link.status === "offline") return `${link.machineName} is unreachable; the thread may still run there.`;
  if (link.result?.state === "branch") return `${link.result.branch}: ${link.result.commits} commit${link.result.commits === 1 ? "" : "s"}, ${link.result.files} file${link.result.files === 1 ? "" : "s"}`;
  return link.there?.lastMessage ?? (link.status === "sending" ? `Sending this project's state to ${link.machineName}…` : `Works in ${link.worktree ?? "a worktree there"}`);
}

function useThreadLinks(host: HostExtensionClient, root: string | undefined) {
  const [links, setLinks] = useState<RemoteThreadLink[]>([]);
  useEffect(() => {
    if (!root) return undefined;
    let live = true;
    host.invoke("threads", {}).then((value) => { if (live && Array.isArray(value)) setLinks((value as RemoteThreadLink[]).filter((link) => link.root === root)); }, () => undefined);
    const stop = host.onEvent(THREAD_LINK_EVENT, (payload) => {
      const link = payload as RemoteThreadLink;
      if (!live || !link?.id || link.root !== root) return;
      setLinks((current) => [link, ...current.filter((entry) => entry.id !== link.id)].sort((left, right) => right.createdAt - left.createdAt));
    });
    return () => { live = false; stop(); };
  }, [host, root]);
  return links;
}

function ThreadLinkRow({ link, host, allowed, now, onNotify, openThere }: {
  link: RemoteThreadLink;
  host: HostExtensionClient;
  allowed: boolean;
  now: number;
  onNotify(message: string): void;
  /** Moves the window to the machine with the thread open; absent where the client cannot. */
  openThere?(link: RemoteThreadLink): Promise<void>;
}) {
  const [busy, setBusy] = useState<string>();
  const run = (command: "thread-abort" | "thread-result" | "thread-settle", input: Record<string, unknown>, label: string) => {
    setBusy(`${command}${String(input.how ?? "")}`);
    // A settled link's summary says what happened already.
    host.invoke(command, { link: link.id, ...input }).then((value) => {
      const next = value as RemoteThreadLink;
      onNotify(next.settled || next.applied ? threadSummary(next) : `${label}: ${threadSummary(next)}`);
    }, (error: unknown) => onNotify(errorMessage(error))).finally(() => setBusy(undefined));
  };
  const working = link.status === "running" || link.status === "starting";
  const quiet = link.status === "idle" || link.status === "waiting" || link.status === "failed";
  const cost = remoteCost(link.usage);
  const open = link.status !== "settled" && link.status !== "gone";
  // Looking works Read only too; answering there is that machine's to allow.
  const there = openThere && link.thread && open && link.status !== "offline" ? () => {
    setBusy("open");
    openThere(link).catch((error: unknown) => { setBusy(undefined); onNotify(errorMessage(error)); });
  } : undefined;
  return (
    <SettingRow
      title={<>{link.machineName} · {link.title ?? "Thread"} <small className="remote-work-age">{formatAge(link.createdAt, now)}</small></>}
      description={<>
        <span className={`remote-work-thread-status ${link.status}`}>{STATUS_LABELS[link.status]}</span>
        {cost ? <span className="remote-work-thread-cost" aria-label="Cost there">{cost}</span> : null}
        <span className={`remote-work-summary ${link.status}`}>{threadSummary(link)}</span>
      </>}
      disabledReason={allowed ? undefined : READ_ONLY_REASON}
      control={open ? (
        <span className="remote-work-actions">
          {there ? <button type="button" className={link.status === "waiting" ? "chrome-button" : "text-button"} disabled={Boolean(busy)} onClick={there}>{busy === "open" ? "Opening…" : `Open on ${link.machineName}`}</button> : null}
          {working ? <button type="button" className="chrome-button" disabled={Boolean(busy) || !allowed} onClick={() => run("thread-abort", {}, "Stopped")}>{busy === "thread-abort" ? "Stopping…" : "Stop"}</button> : null}
          {quiet && link.transfer ? <button type="button" className="chrome-button" disabled={Boolean(busy) || !allowed} onClick={() => run("thread-result", {}, "Brought back")}>{busy === "thread-result" ? "Bringing back…" : link.result ? "Bring back again" : "Bring back"}</button> : null}
          {quiet && link.transfer ? <button type="button" className="chrome-button" disabled={Boolean(busy) || !allowed} onClick={() => run("thread-settle", { how: "apply" }, "Merged")}>{busy === "thread-settleapply" ? "Merging…" : "Merge"}</button> : null}
          {link.status !== "sending" ? <button type="button" className="text-button" disabled={Boolean(busy) || !allowed} onClick={() => run("thread-settle", { how: "discard" }, "Let go")}>Let go</button> : null}
        </span>
      ) : undefined}
    />
  );
}

/**
 * Settings → Remote work, for the open project: which ignored files go along
 * when its work moves to another machine (chosen once, remembered by this
 * machine), and the transfers made from it, with their result.
 */
export function createRemoteWorkPage(host: HostExtensionClient, openThere?: (link: RemoteThreadLink) => Promise<void>) {
  return function RemoteWorkPage({ cwd, onNotify }: SettingsPageProps) {
    const { view, setView, problem, setProblem } = useIgnoredFiles(host, cwd);
    const transfers = useTransfers(host, cwd, view?.root);
    const threads = useThreadLinks(host, view?.root);
    // A thread's transfer is steered from its own row.
    const ownTransfers = transfers.filter((transfer) => !threads.some((link) => link.transfer === transfer.id));
    const canChoose = useCommandAllowed(ID, "set-ignored-files");
    const canAct = useCommandAllowed(ID, "apply");
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), 60_000);
      return () => window.clearInterval(timer);
    }, []);
    const toggle = useCallback((path: string, on: boolean) => {
      if (!cwd || !view) return;
      const paths = on ? [...view.selected, path] : view.selected.filter((entry) => entry !== path);
      setView({ ...view, selected: paths });
      host.invoke("set-ignored-files", { cwd, paths }).then((value) => setView(value as IgnoredFilesView), (error: unknown) => setProblem(errorMessage(error)));
    }, [cwd, view, setView, setProblem]);

    if (!cwd) {
      return (
        <div className="settings-page remote-work-page">
          <h3>Remote work</h3>
          <Empty icon={<FolderSync size={20} />} title="No project open" description="Open a project to choose what goes along when its work moves to another machine." />
        </div>
      );
    }
    return (
      <div className="settings-page remote-work-page">
        <h3>Remote work</h3>
        <SettingsSection title="Ignored files that go along">
          {!view && !problem ? <Skeleton shape="card" /> : null}
          {view && view.candidates.length === 0 ? <Empty size="compact" title="Nothing to offer" description="This project has no ignored files Tau would send along." /> : null}
          {view?.candidates.map((candidate) => {
            const on = view.selected.includes(candidate.path);
            return (
              <SettingRow
                key={candidate.path}
                id={`remote-work-ignored-${candidate.path}`}
                title={<code>{candidate.path}</code>}
                description={`${REASONS[candidate.reason]} · ${candidate.files} file${candidate.files === 1 ? "" : "s"} · ${formatBytes(candidate.bytes)}`}
                disabledReason={canChoose ? undefined : READ_ONLY_REASON}
                control={<button type="button" role="switch" aria-checked={on} aria-label={`Send ${candidate.path} along`} className={`switch ${on ? "on" : ""}`} disabled={!canChoose} onClick={() => toggle(candidate.path, !on)}><i /></button>}
              />
            );
          })}
          {view && view.skipped.length > 0 ? (
            <SettingRow
              title="Never sent"
              description={`${view.skipped.slice(0, 6).map((entry) => `${entry.path} (${SKIPPED[entry.why] ?? entry.why})`).join(", ")}${view.skipped.length > 6 ? ` and ${view.skipped.length - 6} more` : ""}`}
            />
          ) : null}
        </SettingsSection>
        {problem ? <div className="settings-note" data-level="error" role="alert">{problem}</div> : null}
        {threads.length > 0 ? (
          <SettingsSection title="Threads on other machines">
            {threads.map((link) => <ThreadLinkRow key={link.id} link={link} host={host} allowed={canAct} now={now} onNotify={onNotify} {...(openThere ? { openThere } : {})} />)}
          </SettingsSection>
        ) : null}
        <SettingsSection title="Transfers">
          {ownTransfers.length === 0 ? <Empty size="compact" title="No transfers yet" description="Work this project sends to another machine shows here, with what came back." /> : null}
          {ownTransfers.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} host={host} allowed={canAct} now={now} onNotify={onNotify} />)}
        </SettingsSection>
        <p className="settings-note">
          A project goes to another machine as its commits and its uncommitted work. Ignored files stay here unless you tick them:
          Tau offers small text files, <code>.env</code> files and note or issue folders, never dependencies, builds or caches. They
          travel over Tau&apos;s encrypted connection, and your choice is remembered for this project on this machine.
        </p>
      </div>
    );
  };
}
