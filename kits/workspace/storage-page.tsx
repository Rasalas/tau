import { useCallback, useEffect, useState } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { Badge, Button, NumberField, SegmentedControl, SettingRow, SettingsSection, SettingsState, Switch, errorMessage, useThreadStore, type SettingsPageProps, type ThreadStore } from "tau";
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

/** The page's rows, for the Settings search: the rules as this machine holds them. */
export const STORAGE_SETTINGS_ROWS = [
  { id: "setting-workspace-storage-scope", label: "Rules for", keywords: ["repository", "project", "this machine", "override"] },
  { id: "setting-workspace-storage-thread-deleted", label: "Delete worktrees with deleted threads", keywords: ["cleanup", "remove", "thread"] },
  { id: "setting-workspace-storage-inactive", label: "Delete inactive worktrees", keywords: ["cleanup", "days", "retention", "old"] },
  { id: "setting-workspace-storage-merged", label: "Delete merged worktrees", keywords: ["cleanup", "pull request", "merged branch"] },
  { id: "setting-workspace-storage-unchanged", label: "Delete unchanged worktrees", keywords: ["cleanup", "no commits"] },
  { id: "setting-workspace-storage-worktrees", label: "Worktrees", keywords: ["disk space", "size", "measure", "clean up now", "remove worktree"] },
];

/** Days since the last activity, as first set when the rule is switched on. */
const DEFAULT_DAYS = 8;

function RuleRows({ rules, onChange }: { rules: WorktreeCleanupRules; onChange(patch: Partial<WorktreeCleanupRules>): void }) {
  // The policy is Workspace Kit's own file with its own per-repository scope, so these rows have no config level.
  return (
    <>
      <SettingRow id="setting-workspace-storage-thread-deleted" title="Delete worktrees with deleted threads" description="Once the last thread that worked there is deleted."
        control={<Switch label="Delete worktrees with deleted threads" checked={rules.onThreadDelete} onChange={(onThreadDelete) => onChange({ onThreadDelete })} />} />
      <SettingRow id="setting-workspace-storage-inactive" title="Delete inactive worktrees" description="No thread, commit or change there for this many days."
        control={<>
          {rules.afterDays !== null ? (
            <NumberField label="Delete inactive worktrees after" value={rules.afterDays} min={1} max={3650} integer unit="days"
              onCommit={(days) => { if (days !== rules.afterDays) onChange({ afterDays: days }); }} />
          ) : null}
          <Switch label="Delete inactive worktrees" checked={rules.afterDays !== null} onChange={(on) => onChange({ afterDays: on ? DEFAULT_DAYS : null })} />
        </>} />
      <SettingRow id="setting-workspace-storage-merged" title="Delete merged worktrees" description="Every commit of the branch is in the default branch, or its pull request was merged."
        control={<Switch label="Delete merged worktrees" checked={rules.onMerge} onChange={(onMerge) => onChange({ onMerge })} />} />
      <SettingRow id="setting-workspace-storage-unchanged" title="Delete unchanged worktrees" description="No commits beyond the branch they started from."
        control={<Switch label="Delete unchanged worktrees" checked={rules.unchanged} onChange={(unchanged) => onChange({ unchanged })} />} />
    </>
  );
}

type Scope = "host" | "project";

const CLEANUP_MODES = [
  { value: "inherit", label: "Inherit" },
  { value: "off", label: "Off" },
  { value: "custom", label: "Custom" },
] as const;

function Status({ tree }: { tree: UiStorageWorktree }) {
  const { verdict } = tree;
  if (verdict.remove) return <Badge tone="warn">Next cleanup · {verdict.reasons.map((reason) => REASONS[reason]).join(", ")}</Badge>;
  if (verdict.reasons.length > 0) return <Badge>Kept · {verdict.blockers.map((blocker) => BLOCKERS[blocker]).join(", ")}</Badge>;
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
        <span className="workspace-storage-status"><Status tree={tree} /></span>
      </div>
      <span className="workspace-storage-size">{formatBytes(tree.sizeBytes)}</span>
      <Button variant="ghost" aria-label={`Remove ${tree.path}`} disabled={busy} onClick={() => void remove(false)}>Remove</Button>
      {confirming ? (
        <div className="workspace-storage-confirm" role="alert">
          <span>{removalWarning(confirming)}</span>
          <Button onClick={() => setConfirming(undefined)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove(true)}>Remove anyway</Button>
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
    const lastSweep = report?.lastSweep ? ` Last cleanup ${formatAge(report.lastSweep.at, now)} removed ${report.lastSweep.removed.length}.` : "";

    const rules = !policy ? (
      error ? <SettingsState kind="error" title="The cleanup rules did not load" description={error} onRetry={() => void refresh()} />
        : <SettingsState kind="loading" title="Reading the cleanup rules" rows={4} />
    ) : scope === "project" && repository ? <>
      <SettingRow
        id="setting-workspace-storage-mode"
        title="Automatic worktree cleanup"
        description={mode === "off" ? "This repository keeps its worktrees until you delete them." : mode === "custom" ? "The rules below, for this repository only." : "This repository follows this machine's rules."}
        control={<SegmentedControl label="Automatic worktree cleanup" value={mode} options={CLEANUP_MODES} onChange={(choice) => void change({ project: repository.path, mode: choice })} />}
      />
      {mode === "custom" ? (
        <RuleRows rules={rulesFor(policy, repository.path)} onChange={(next) => void change({ project: repository.path, mode: "custom", rules: next })} />
      ) : null}
    </> : <RuleRows rules={policy.host ?? NO_CLEANUP} onChange={(next) => void change({ rules: next })} />;

    return (
      <div className="settings-page workspace-storage">
        <h3>Storage</h3>

        <SettingsSection title="Worktree cleanup">
          {repository && policy ? (
            <SettingRow
              id="setting-workspace-storage-scope"
              title="Rules for"
              description={`This machine's rules apply to every repository without its own; ${repository.name} is the one on screen.`}
              control={<SegmentedControl<Scope> label="Rules for" value={scope} options={[{ value: "host", label: "This machine" }, { value: "project", label: repository.name }]} onChange={setScope} />}
            />
          ) : null}
          {rules}
        </SettingsSection>

        <SettingsSection
          id="setting-workspace-storage-worktrees"
          title={`Worktrees${report ? ` · ${formatBytes(report.totalBytes)}` : ""}`}
          headerAction={<Button variant="ghost" icon={<RefreshCw size={13} />} busy={loading} onClick={() => void refresh()}>Measure again</Button>}
        >
          {error && report ? <SettingsState kind="error" title="The worktrees could not be measured" description={error} onRetry={() => void refresh()} /> : null}
          {!report && !error ? <SettingsState kind="loading" title="Measuring worktrees" rows={3} /> : null}
          {!report && error ? <SettingsState kind="empty" title="Nothing measured yet" description="The worktrees show here once the rules above load." /> : null}
          {report && report.worktrees.length === 0 ? (
            <SettingsState kind="empty" title="No worktree Tau made is on disk" description={`A thread that runs in a new worktree adds one here, with its size and what the next cleanup would do with it.${lastSweep}`} />
          ) : null}
          {report && report.worktrees.length > 0 ? <>
            <SettingRow
              title="Clean up now"
              description={`${due.length === 0 ? "The rules would remove nothing now." : `The rules would remove ${due.length} worktree${due.length === 1 ? "" : "s"} now.`}${lastSweep}`}
              {...(due.length === 0 ? { disabledReason: "No worktree matches the rules now." } : {})}
              control={<Button variant="primary" busy={busy} disabled={due.length === 0} onClick={() => void cleanUp()}>{due.length === 0 ? "Clean up now" : `Clean up ${due.length} now`}</Button>}
            />
            <ul className="workspace-storage-list" aria-label="Worktrees">
              {report.worktrees.map((tree) => <WorktreeRow key={tree.path} tree={tree} now={now} titles={titles} busy={busy} onRemove={onRemove} />)}
            </ul>
          </> : null}
        </SettingsSection>
      </div>
    );
  };
}
