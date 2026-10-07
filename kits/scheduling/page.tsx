import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, MoreHorizontal } from "lucide-react";
import { Dialog, errorMessage, tooltipProps, useThreadStore, type PageProps, type WorkbenchActions } from "tau";
import { AutomationEditor } from "./editor.js";
import { needsDecision, type SchedulingFeed } from "./feed.js";
import type { Job, ManagementState } from "./protocol.js";

const busyJob = (job: Job) => job.status === "running" || job.status === "starting";
const utc = (at?: string) => at ? new Date(at).toLocaleString([], { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC" : "";
export function statusText(job: Job): string {
  if (job.status === "held") return job.detail ?? `Missed ${utc(job.nextAt)}. This host did not run it.`;
  if (job.status === "failed") return `Couldn't start or finish: ${job.lastRun?.detail ?? job.detail ?? "inspect the thread"}`;
  if (job.status === "uncertain") return `Tau restarted while starting the ${utc(job.lastRun?.at)} run. Unclear whether a thread started.`;
  if (busyJob(job)) return `${job.status === "starting" ? "Starting" : "Running"} since ${utc(job.lastRun?.at)}`;
  if (!job.enabled) return "Off";
  const next = job.config.schedule.kind === "webhook" ? "Waiting for signed delivery" : `Next: ${utc(job.nextAt) || "no future run"}`;
  return `${next}${job.lastRun ? ` · Last run ${utc(job.lastRun.at)} · ${job.lastRun.outcome === "completed" ? "finished" : job.lastRun.outcome}` : ""}`;
}

function ResolveDialog({ job, feed, onClose, openThread }: { job: Job; feed: SchedulingFeed; onClose(): void; openThread(): void }) {
  const [decision, setDecision] = useState<"skip" | "run">("skip");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { await feed.invoke("resolve", { id: job.id, decision, ...(decision === "run" ? { acknowledgeDuplicateRisk: acknowledged } : {}) }); onClose(); }
    catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  return createPortal(<Dialog label={`Resolve ${job.config.name}`} className="confirm-dialog scheduling-dialog" onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <header><h2>Did "{job.config.name}" start?</h2><p>Tau cannot prove whether a thread started. Inspect it before deciding. Either way the automation turns off.</p></header>
    {job.lastRun?.threadId ? <button type="button" onClick={openThread}>Inspect recorded thread</button> : <p>No thread was recorded. Search recent "Scheduled:" threads before retrying.</p>}
    <label className="scheduling-checkbox"><input type="radio" name="recovery" checked={decision === "skip"} onChange={() => setDecision("skip")} disabled={busy} />Skip this run</label>
    <label className="scheduling-checkbox"><input type="radio" name="recovery" checked={decision === "run"} onChange={() => setDecision("run")} disabled={busy || !feed.get().state?.enabled} />Run it again now</label>
    {decision === "run" ? <label className="scheduling-checkbox"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={busy} />I checked the threads: running again may create a second thread.</label> : null}
    {error ? <p role="alert" className="scheduling-error">{error}</p> : null}
    <footer><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy || (decision === "run" && !acknowledged)}>Confirm decision</button></footer>
  </form></Dialog>, document.body);
}

function AutomationRow({ job, state, feed, actions, edit, resolve }: { job: Job; state: ManagementState; feed: SchedulingFeed; actions: WorkbenchActions; edit(): void; resolve(): void }) {
  const threads = useThreadStore();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const run = async (command: string, input: unknown = { id: job.id }) => {
    setBusy(true); setError(undefined); setMenu(false);
    try { await feed.invoke(command, input); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const open = () => { void openAutomationThread(job, feed, actions, threads.getThread(job.lastRun?.threadId ?? "")?.path); };
  const disabled = busy || !state.canManage;
  const running = busyJob(job);
  return <article className={`scheduling-row ${needsDecision(job) ? "needs-you" : ""}`}>
    <div className="scheduling-row-main"><h3>{job.config.name}</h3><p>{statusText(job)}</p><small>{job.config.workspace.split(/[\\/]/u).pop()} · {job.config.backend}{job.config.schedule.kind === "daily" ? ` · Every day ${job.config.schedule.time} UTC` : job.config.schedule.kind === "webhook" ? " · Signed webhook" : ` · Once ${utc(job.config.schedule.at)}`}</small></div>
    <div className="scheduling-row-actions">
      {job.status === "held" || job.status === "failed" ? <><button disabled={disabled || !state.enabled} onClick={() => void run("resolve", { id: job.id, decision: "run" })}>{job.status === "failed" ? "Try again" : "Run now"}</button><button disabled={disabled} onClick={() => void run("resolve", { id: job.id, decision: "skip" })}>Skip</button></> : job.status === "uncertain" ? <><button onClick={job.lastRun?.threadId ? open : () => actions.notify('Search recent threads titled "Scheduled:" before resolving this run.')}>{job.lastRun?.threadId ? "Find its thread" : "Inspect threads"}</button><button disabled={disabled} onClick={resolve}>Resolve…</button></> : running ? <button disabled={!job.lastRun?.threadId} onClick={open}>Open thread</button> : <button type="button" role="switch" aria-checked={job.enabled} aria-label={`${job.enabled ? "Turn off" : "Turn on"} ${job.config.name}`} className="scheduling-switch" disabled={disabled} onClick={() => void run(job.enabled ? "disable" : "enable")} {...tooltipProps(!state.canManage ? "Manage automations in this host's own Tau window." : undefined)}><span /></button>}
      <details className="scheduling-menu" open={menu} onToggle={(event) => setMenu(event.currentTarget.open)}><summary aria-label={`More actions for ${job.config.name}`}><MoreHorizontal size={16} /></summary><div>
        {running ? <p>Running automations can't be changed.</p> : <>{!needsDecision(job) ? <><button disabled={disabled || !state.enabled} onClick={() => void run("run")}>Run now</button><button disabled={disabled} onClick={() => { setMenu(false); edit(); }}>Edit</button></> : null}{job.lastRun?.threadId ? <button onClick={open}>Open last thread</button> : null}<button disabled={disabled} onClick={() => { setMenu(false); setDeleting(true); }}>Delete</button></>}
      </div></details>
    </div>
    {job.config.schedule.kind === "webhook" && job.enabled && state.webhookUrl ? <details className="scheduling-webhook-info"><summary>Webhook endpoint</summary><code>{state.webhookUrl}/{job.id}</code><p>This endpoint is on the host. Use your reverse proxy for a sender elsewhere. Sign each POST with HMAC-SHA256 over <code>timestamp + "\n" + deliveryId + "\n" + rawBody</code>. Headers: <code>X-Tau-Timestamp</code> in epoch milliseconds, <code>X-Tau-Delivery</code> a unique ID, <code>X-Tau-Signature</code> lowercase hex. Deliver within five minutes. The payload stays out of the conversation.</p></details> : null}
    {error ? <p role="alert" className="scheduling-error">{error}</p> : null}
    {deleting ? createPortal(<Dialog label="Delete automation" className="confirm-dialog scheduling-dialog" onClose={() => setDeleting(false)}><h2>Delete "{job.config.name}"?</h2><p>Its threads stay. Its private webhook key is removed.</p><footer><button autoFocus onClick={() => setDeleting(false)}>Cancel</button><button className="danger" onClick={() => { setDeleting(false); void run("delete"); }}>Delete automation</button></footer></Dialog>, document.body) : null}
  </article>;
}

async function openAutomationThread(job: Job, feed: SchedulingFeed, actions: WorkbenchActions, knownPath?: string): Promise<void> {
  try {
    const path = knownPath ?? await feed.host.invoke("thread-path", { id: job.id }) as string | undefined;
    if (path) await actions.switchSession(path);
    else actions.notify('No thread was recorded. Inspect recent "Scheduled:" threads before retrying.');
  } catch (failure) { actions.notify(errorMessage(failure)); }
}

export default function AutomationsPage({ actions, params, feed }: PageProps & { feed: SchedulingFeed }) {
  const view = useSyncExternalStore(feed.subscribe, feed.get);
  const store = useThreadStore();
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const [editor, setEditor] = useState<Job | "new">();
  const [resolving, setResolving] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (params.create && view.state?.canManage) setEditor("new"); }, [params.create, view.state?.canManage]);
  const state = view.state;
  const toggle = async () => {
    if (!state) return;
    setBusy(true); setError(undefined);
    try { await feed.invoke("set-enabled", { enabled: !state.enabled }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  if (!state) return <div className="scheduling-page"><p role={view.error ? "alert" : "status"}>{view.error ?? "Loading automations…"}</p>{view.error ? <button onClick={() => void feed.read()}>Try again</button> : null}</div>;
  const groups = [
    { name: "Needs you", jobs: state.jobs.filter(needsDecision) },
    { name: "Running", jobs: state.jobs.filter(busyJob) },
    { name: "Scheduled", jobs: state.jobs.filter((job) => !needsDecision(job) && !busyJob(job) && job.enabled) },
    { name: "Off", jobs: state.jobs.filter((job) => !needsDecision(job) && !busyJob(job) && !job.enabled) },
  ];
  return <div className="scheduling-page">
    {state.webhookProblem ? <p className="scheduling-error" role="alert">{state.webhookProblem}</p> : null}
    <div className="scheduling-toolbar"><div className="scheduling-toolbar-toggle"><button className="scheduling-switch" role="switch" aria-label="Automations" aria-checked={state.enabled} disabled={!state.canManage || busy} onClick={() => void toggle()}><span /></button><span>Automations {state.enabled ? "on" : "off"}</span></div><button className="primary" disabled={!state.canManage} onClick={() => setEditor("new")}>New automation</button></div>
    {!state.canManage ? <p className="scheduling-banner">You can inspect automations here. Manage them in this host's own Tau window.</p> : null}
    {!state.enabled ? <p className="scheduling-banner">Automations are off. Timers, signed deliveries and Run now won't start work. Existing threads keep running.</p> : null}
    {error || view.error ? <p role="alert" className="scheduling-error">{error ?? view.error}</p> : null}
    {!state.jobs.length ? <div className="scheduling-empty"><CalendarClock size={28} /><h2>A prompt, on your schedule</h2><p>Save work you repeat. Every run gets its own thread, so you can inspect and steer it.</p></div> : groups.filter((group) => group.jobs.length).map((group) => <section className="scheduling-group" key={group.name}><h2>{group.name}<span>{group.jobs.length}</span></h2>{group.jobs.map((job) => <AutomationRow key={job.id} job={job} state={state} feed={feed} actions={actions} edit={() => setEditor(job)} resolve={() => setResolving(job)} />)}</section>)}
    {editor ? <AutomationEditor job={editor === "new" ? undefined : editor} feed={feed} state={state} projects={projects} actions={actions} onClose={() => setEditor(undefined)} /> : null}
    {resolving ? <ResolveDialog job={resolving} feed={feed} onClose={() => setResolving(undefined)} openThread={() => { void openAutomationThread(resolving, feed, actions, store.getThread(resolving.lastRun?.threadId ?? "")?.path); }} /> : null}
  </div>;
}
