import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { errorMessage, useThreadStore, type SettingsPageProps, type ThreadStore } from "tau";
import type {
  CleanupBlocker,
  CleanupPolicy,
  CleanupPolicyPatch,
  CleanupReason,
  UiCleanupResult,
  UiStorageRemoval,
  UiStorageReport,
  UiStorageWorktree,
  WorktreeCleanupRules,
} from "./storage-protocol.js";
import { NO_CLEANUP, rulesFor } from "./worktree-cleanup.js";

/** What the page asks of Workspace Kit's host half. */
export interface StorageHost {
  report(): Promise<UiStorageReport>;
  setPolicy(patch: CleanupPolicyPatch): Promise<CleanupPolicy>;
  cleanUp(paths: string[]): Promise<UiCleanupResult>;
  remove(path: string, confirm: boolean): Promise<UiStorageRemoval>;
  /** Called when a sweep or a removal changed what is on disk. */
  onChanged(listener: () => void): () => void;
}

const REASONS: Record<CleanupReason, string> = {
  inactive: "inactive",
  merged: "merged",
  "thread-deleted": "thread deleted",
  unchanged: "unchanged",
};

const BLOCKERS: Record<CleanupBlocker, string> = {
  "not-recorded": "not made by Tau",
  missing: "folder is gone",
  "inspection-failed": "Git could not read it",
  "outside-worktrees-dir": "outside the worktrees folder",
  "not-linked": "not a linked worktree",
  "host-workspace": "open in Tau",
  "thread-open": "a thread is open there",
  uncommitted: "uncommitted changes",
  "ignored-files": "ignored files",
  unpushed: "unpushed commits",
};

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The index is the page's only source for titles; outside a workbench there is none. */
function useThreadTitles(): ThreadStore | undefined {
  try {
    return useThreadStore();
  } catch {
    return undefined;
  }
}

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange(next: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}><i /></button>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="settings-field-row">
      <span className="settings-field-label"><strong>{title}</strong><small>{hint}</small></span>
      {children}
    </div>
  );
}

/** Days, or off: T3 Code's retention control, eight days when switched on. */
function Retention({ value, onChange }: { value: number | null; onChange(next: number | null): void }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => { setDraft(value === null ? "" : String(value)); }, [value]);
  const commit = () => {
    const days = Number(draft);
    if (value !== null && Number.isFinite(days) && days >= 1 && Math.round(days) !== value) onChange(Math.round(days));
    else setDraft(value === null ? "" : String(value));
  };
  return (
    <span className="workspace-storage-retention">
      {value === null ? <small>Off</small> : (
        <label>
          <input
            type="number"
            min={1}
            max={3650}
            value={draft}
            aria-label="Delete inactive worktrees in days"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
          />
          <small>days</small>
        </label>
      )}
      <Switch label="Delete inactive worktrees" on={value !== null} onChange={(on) => onChange(on ? 8 : null)} />
    </span>
  );
}

function RuleRows({ rules, onChange }: { rules: WorktreeCleanupRules; onChange(patch: Partial<WorktreeCleanupRules>): void }) {
  return (
    <>
      <Row title="Delete worktrees with deleted threads" hint="Once the last thread that worked there is deleted">
        <Switch label="Delete worktrees with deleted threads" on={rules.onThreadDelete} onChange={(onThreadDelete) => onChange({ onThreadDelete })} />
      </Row>
      <Row title="Delete inactive worktrees" hint="No thread, commit or change there for this long">
        <Retention value={rules.afterDays} onChange={(afterDays) => onChange({ afterDays })} />
      </Row>
      <Row title="Delete merged worktrees" hint="Every commit of the branch is in the default branch">
        <Switch label="Delete merged worktrees" on={rules.onMerge} onChange={(onMerge) => onChange({ onMerge })} />
      </Row>
      <Row title="Delete unchanged worktrees" hint="No commits beyond the branch they started from">
        <Switch label="Delete unchanged worktrees" on={rules.unchanged} onChange={(unchanged) => onChange({ unchanged })} />
      </Row>
    </>
  );
}

type Scope = "host" | "project";

function Status({ tree }: { tree: UiStorageWorktree }) {
  const { verdict } = tree;
  if (verdict.remove) return <span className="workspace-storage-status due">Next cleanup · {verdict.reasons.map((reason) => REASONS[reason]).join(", ")}</span>;
  if (verdict.reasons.length > 0) {
    return <span className="workspace-storage-status kept">Kept · {verdict.blockers.map((blocker) => BLOCKERS[blocker]).join(", ")}</span>;
  }
  return null;
}

function removalWarning(answer: Extract<UiStorageRemoval, { removed: false }>): string {
  const parts: string[] = [];
  if (answer.dirtyFiles > 0) parts.push(`${answer.dirtyFiles} uncommitted file${answer.dirtyFiles === 1 ? "" : "s"} will be lost`);
  if (answer.confirm.includes("ignored-files")) parts.push("ignored files such as .env will be lost");
  if (answer.unpushedCommits > 0) parts.push(`${answer.unpushedCommits} unpushed commit${answer.unpushedCommits === 1 ? " stays" : "s stay"} on the branch only`);
  return `${parts.join("; ")}. The branch is kept.`;
}

function WorktreeRow({ tree, now, titles, busy, onRemove }: {
  tree: UiStorageWorktree;
  now: number;
  titles: ThreadStore | undefined;
  busy: boolean;
  onRemove(tree: UiStorageWorktree, confirm: boolean): Promise<UiStorageRemoval | undefined>;
}) {
  const [confirming, setConfirming] = useState<Extract<UiStorageRemoval, { removed: false }>>();
  const threadNames = tree.threadIds.map((id) => titles?.getThread(id)?.title || "Untitled thread");
  const threadLabel = tree.threadIds.length === 0 ? "no thread" : tree.threadIds.length === 1 ? threadNames[0] : `${tree.threadIds.length} threads`;
  const remove = async (confirm: boolean) => {
    const answer = await onRemove(tree, confirm);
    setConfirming(answer && !answer.removed ? answer : undefined);
  };
  return (
    <li className="workspace-storage-row" data-path={tree.path} data-due={tree.verdict.remove || undefined}>
      <div className="workspace-storage-main">
        <span className="workspace-storage-name">
          <FolderGit2 size={13} />
          <strong>{tree.branch ?? tree.path.split(/[\\/]/u).pop()}</strong>
          <small>{tree.repositoryName}</small>
        </span>
        <code className="workspace-storage-path" title={tree.path}>{tree.path}</code>
        <span className="workspace-storage-facts">
          <span title={threadNames.join("\n")}>{threadLabel}</span>
          <span>active {formatAge(tree.lastActivityAt, now)}</span>
          {tree.dirtyFiles > 0 ? <span>{tree.dirtyFiles} uncommitted</span> : null}
          {tree.unpushedCommits > 0 ? <span>{tree.unpushedCommits} unpushed</span> : null}
        </span>
        <Status tree={tree} />
      </div>
      <span className="workspace-storage-size">{formatBytes(tree.sizeBytes)}</span>
      <button type="button" className="text-button workspace-storage-remove" aria-label={`Remove ${tree.path}`} disabled={busy} onClick={() => void remove(false)}>Remove</button>
      {confirming ? (
        <div className="workspace-storage-confirm" role="alert">
          <span>{removalWarning(confirming)}</span>
          <button type="button" className="text-button" onClick={() => setConfirming(undefined)}>Cancel</button>
          <button type="button" className="text-button danger" disabled={busy} onClick={() => void remove(true)}>Remove anyway</button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Settings → Storage: the rules that remove worktrees, host-wide and for the
 * repository on screen, and every worktree Tau made with its size, its threads
 * and what the next cleanup would do with it. The list is the dry run; "Clean
 * up now" removes exactly the rows it marks.
 */
export function createStoragePage(host: StorageHost) {
  return function StorageSettings({ onNotify }: SettingsPageProps) {
    const [report, setReport] = useState<UiStorageReport>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [scope, setScope] = useState<Scope>("host");
    const titles = useThreadTitles();

    const refresh = useCallback(async () => {
      setLoading(true);
      try {
        setReport(await host.report());
        setError(undefined);
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setLoading(false);
      }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => host.onChanged(() => { void refresh(); }), [refresh]);

    const change = async (patch: CleanupPolicyPatch) => {
      try {
        const policy = await host.setPolicy(patch);
        setReport((current) => current ? { ...current, policy } : current);
        void refresh();
      } catch (failure) {
        onNotify(errorMessage(failure));
      }
    };
    const onRemove = async (tree: UiStorageWorktree, confirm: boolean) => {
      setBusy(true);
      try {
        const answer = await host.remove(tree.path, confirm);
        if (answer.removed) {
          onNotify(tree.branch ? `Removed ${tree.path}; the branch ${tree.branch} stays.` : `Removed ${tree.path}.`);
          await refresh();
        }
        return answer;
      } catch (failure) {
        onNotify(errorMessage(failure));
        return undefined;
      } finally {
        setBusy(false);
      }
    };
    const due = report?.worktrees.filter((tree) => tree.verdict.remove) ?? [];
    const cleanUp = async () => {
      setBusy(true);
      try {
        const result = await host.cleanUp(due.map((tree) => tree.path));
        const kept = result.kept.length > 0 ? ` ${result.kept.length} changed since and stayed.` : "";
        onNotify(`Removed ${result.removed.length} worktree${result.removed.length === 1 ? "" : "s"}.${kept}`);
        await refresh();
      } catch (failure) {
        onNotify(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    };

    const policy = report?.policy;
    const repository = report?.currentRepository;
    const override = repository && policy ? policy.projects[repository.path] : undefined;
    const mode = override?.mode ?? "inherit";
    const now = report?.generatedAt ?? Date.now();

    return (
      <div className="settings-page workspace-storage">
        <h3>Storage</h3>
        <p className="lede">
          Worktrees Tau made for threads, what they take on disk, and the rules that remove them. A rule never removes
          uncommitted work, unpushed commits or ignored files other than node_modules, and every branch stays.
        </p>

        <div className="settings-label">WORKTREE CLEANUP</div>
        {repository ? (
          <div className="segmented workspace-storage-scope" role="group" aria-label="Rules for">
            <button type="button" className={scope === "host" ? "active" : ""} aria-pressed={scope === "host"} onClick={() => setScope("host")}>This host</button>
            <button type="button" className={scope === "project" ? "active" : ""} aria-pressed={scope === "project"} onClick={() => setScope("project")}>{repository.name}</button>
          </div>
        ) : null}
        {policy ? (
          scope === "project" && repository ? (
            <>
              <Row
                title="Automatic worktree cleanup"
                hint={mode === "off" ? "Keep this repository's worktrees until you delete them" : mode === "custom" ? "These rules, for this repository" : "The host's rules"}
              >
                <div className="segmented" role="group" aria-label="Automatic worktree cleanup">
                  {(["inherit", "off", "custom"] as const).map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={mode === choice ? "active" : ""}
                      aria-pressed={mode === choice}
                      onClick={() => void change({ project: repository.path, mode: choice })}
                    >{choice === "inherit" ? "Inherit" : choice === "off" ? "Off" : "Custom"}</button>
                  ))}
                </div>
              </Row>
              {mode === "custom" ? (
                <RuleRows rules={rulesFor(policy, repository.path)} onChange={(rules) => void change({ project: repository.path, mode: "custom", rules })} />
              ) : null}
            </>
          ) : (
            <RuleRows rules={policy.host ?? NO_CLEANUP} onChange={(rules) => void change({ rules })} />
          )
        ) : null}

        <div className="settings-label workspace-storage-heading">
          <span>WORKTREES{report ? ` · ${formatBytes(report.totalBytes)}` : ""}</span>
          <button type="button" className="icon-button" aria-label="Measure again" title="Measure again" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={12} />
          </button>
        </div>
        {error ? <div className="settings-note" data-level="error">{error}</div> : null}
        {!report && loading ? <p className="workspace-storage-empty"><span className="spinner small" /> Measuring worktrees…</p> : null}
        {report && report.worktrees.length === 0 ? <p className="workspace-storage-empty">No worktree Tau made is on disk.</p> : null}
        {report && report.worktrees.length > 0 ? (
          <>
            <div className="workspace-storage-actions">
              <span>{due.length === 0 ? "The rules would remove nothing now." : `The rules would remove ${due.length} worktree${due.length === 1 ? "" : "s"} now.`}</span>
              <button type="button" className="primary" disabled={busy || due.length === 0} onClick={() => void cleanUp()}>
                {due.length === 0 ? "Clean up now" : `Clean up ${due.length} now`}
              </button>
            </div>
            <ul className="workspace-storage-list" aria-label="Worktrees">
              {report.worktrees.map((tree) => <WorktreeRow key={tree.path} tree={tree} now={now} titles={titles} busy={busy} onRemove={onRemove} />)}
            </ul>
          </>
        ) : null}
        {report?.lastSweep ? (
          <p className="workspace-storage-empty">Last cleanup {formatAge(report.lastSweep.at, now)} removed {report.lastSweep.removed.length}.</p>
        ) : null}
      </div>
    );
  };
}
