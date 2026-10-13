import { useState, useSyncExternalStore, type ComponentType } from "react";
import { CalendarClock, Pencil, Play, SlidersHorizontal } from "lucide-react";
import { errorMessage, tooltipProps, type RegionProps, type WorkbenchActions } from "tau";
import { needsDecision, type SchedulingFeed } from "./feed.js";
import { busyJob, statusText } from "./job-summary.js";
import type { Job, ManagementState } from "./protocol.js";

/** The project followed by Workspace Kit, and its contribution seam. */
export interface WorkspaceSummaryService {
  getSnapshot(): { cwd?: string; workspaceId?: string; workspace?: { root: string; worktrees: readonly { path: string; isMain: boolean }[] } };
  subscribe(listener: () => void): () => void;
  registerWorkspaceSummarySection?(section: ComponentType<RegionProps>, position?: "footer"): () => void;
}

function summary(job: Job, enabled: boolean): string {
  if (needsDecision(job) || busyJob(job)) return statusText(job);
  if (!enabled) return "Automations off";
  if (!job.enabled) return "Off";
  const schedule = job.config.schedule;
  if (schedule.kind === "webhook") return "Waiting for signed delivery";
  const next = job.nextAt ? new Date(job.nextAt).toLocaleString([], { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC" : "no future run";
  return schedule.kind === "daily" ? `Daily at ${schedule.time} UTC · next ${next}` : next;
}

function SummaryRow({ job, state, feed, actions }: { job: Job; state: ManagementState; feed: SchedulingFeed; actions: WorkbenchActions }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const attention = needsDecision(job);
  const running = busyJob(job);
  const disabled = busy || !state.canManage || running || attention;
  const invoke = async (command: string) => {
    setBusy(true); setError(undefined);
    try { await feed.invoke(command, { id: job.id }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const hint = summary(job, state.enabled);
  const open = () => actions.openPage?.("scheduling.automations");
  return <li className="scheduling-summary-row" data-status={job.status}>
    <button type="button" className="scheduling-summary-main" aria-label={`View ${job.config.name}`} onClick={open} {...tooltipProps(`${job.config.name} · ${hint}`, { side: "left" })}>
      <span className="scheduling-summary-icon"><CalendarClock size={16} aria-hidden="true" /><i /></span>
      <span className="scheduling-summary-copy"><span>{job.config.name}</span><small>{hint}</small></span>
    </button>
    <div className="scheduling-summary-actions">
      <button type="button" className="scheduling-summary-action" aria-label={`Edit ${job.config.name}`} disabled={disabled} {...tooltipProps("Edit automation")} onClick={() => actions.openPage?.("scheduling.automations", { edit: job.id })}><Pencil size={15} aria-hidden="true" /></button>
      <button type="button" className="scheduling-summary-action" aria-label={`Run ${job.config.name} now`} disabled={disabled || !state.enabled} {...tooltipProps(attention ? "Resolve this automation before running it again" : running ? "Automation is running" : !state.enabled ? "Automations are off" : "Run now")} onClick={() => void invoke("run")}><Play size={15} aria-hidden="true" /></button>
      <button type="button" className="scheduling-switch" role="switch" aria-checked={job.enabled} aria-label={`${job.enabled ? "Turn off" : "Turn on"} ${job.config.name}`} disabled={disabled} {...tooltipProps(!state.canManage ? "Manage automations in this machine's own Tau window." : attention ? "Resolve this automation on the Automations page" : job.enabled ? "Turn off" : "Turn on")} onClick={() => void invoke(job.enabled ? "disable" : "enable")}><span /></button>
    </div>
    {error ? <p role="alert" className="scheduling-error">{error}</p> : null}
  </li>;
}

export default function AutomationsSummary({ actions, feed, workspace }: RegionProps & { feed: SchedulingFeed; workspace: WorkspaceSummaryService }) {
  const view = useSyncExternalStore(feed.subscribe, feed.get);
  const followed = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const state = view.state;
  const paths = [followed.cwd, followed.workspace?.root, followed.workspace?.worktrees.find((entry) => entry.isMain)?.path].filter(Boolean);
  const jobs = state?.jobs.filter((job) => paths.includes(job.config.workspace) || Boolean(followed.workspaceId && job.workspaceId === followed.workspaceId)) ?? [];
  if (!state || !jobs.length) return null;
  return <section className="scheduling-summary" aria-label="Automations">
    <header><h2>Automations</h2><button type="button" className="scheduling-summary-action" aria-label="Manage automations" {...tooltipProps("Manage automations")} onClick={() => actions.openPage?.("scheduling.automations")}><SlidersHorizontal size={15} aria-hidden="true" /></button></header>
    {view.error ? <p role="alert" className="scheduling-error">{view.error}</p> : null}
    <ul>{jobs.map((job) => <SummaryRow key={job.id} job={job} state={state} feed={feed} actions={actions} />)}</ul>
  </section>;
}
