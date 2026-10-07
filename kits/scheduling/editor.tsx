import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Dialog, ProviderIconStack, errorMessage, tooltipProps, type UiProject, type UiRuntimeBackend, type WorkbenchActions } from "tau";
import type { SchedulingFeed } from "./feed.js";
import type { Job, JobConfig, ManagementState, Schedule } from "./protocol.js";

export function AutomationEditor({ job, actions, feed, state, projects, onClose }: { job?: Job; actions: WorkbenchActions; feed: SchedulingFeed; state: ManagementState; projects: readonly UiProject[]; onClose(): void }) {
  const active = actions.activeThread();
  const [name, setName] = useState(job?.config.name ?? "");
  const [prompt, setPrompt] = useState(job?.config.prompt ?? "");
  const [workspace, setWorkspace] = useState(job?.config.workspace ?? active?.cwd ?? projects[0]?.path ?? "");
  const [backend, setBackend] = useState(job?.config.backend ?? active?.backendKind ?? "pi");
  const [runtimes, setRuntimes] = useState<readonly UiRuntimeBackend[]>([]);
  const [kind, setKind] = useState<Schedule["kind"]>(job?.config.schedule.kind ?? "daily");
  const schedule = job?.config.schedule;
  const [time, setTime] = useState(schedule?.kind === "daily" ? schedule.time : schedule?.kind === "once" ? schedule.at.slice(11, 16) : "09:00");
  const [date, setDate] = useState(schedule?.kind === "once" ? schedule.at.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [secret, setSecret] = useState("");
  const [created, setCreated] = useState<Job | undefined>(job);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { let live = true; void actions.runtimeModels?.().then((entries) => { if (live) setRuntimes(entries.map((entry) => entry.backend).filter((runtime) => runtime.kind !== "machine" && !runtime.kind.startsWith("machine@"))); }, () => undefined); return () => { live = false; }; }, [actions]);
  const choices = runtimes.length ? runtimes : [{ kind: backend, label: backend }];
  const runtimeKey = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, choices.findIndex((runtime) => runtime.kind === backend));
    const index = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
    setBackend(choices[index]!.kind);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(undefined);
    const privateValue = secret; setSecret("");
    try {
      const config: JobConfig = { name, prompt, workspace, backend, schedule: kind === "daily" ? { kind, time, timezone: "UTC" } : kind === "once" ? { kind, at: `${date}T${time}:00Z` } : { kind } };
      const current = created ? await feed.invoke("update", { id: created.id, config }) as Job : await feed.invoke("create", config) as Job;
      // Preserve the ID after a partial save so retry never creates a duplicate automation.
      setCreated(current);
      if (kind === "webhook" && privateValue) {
        await feed.invoke("set-webhook-secret", { id: current.id, value: privateValue });
        const saved = feed.get().state?.jobs.find((entry) => entry.id === current.id);
        if (saved) setCreated(saved);
      }
      if (enabled) await feed.invoke("enable", { id: current.id });
      onClose();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const localTime = new Date(`${date}T${time}:00Z`);
  const hasSavedKey = Boolean(created?.secretRef && created.config.workspace === workspace && created.config.schedule.kind === "webhook");
  return createPortal(<Dialog label={job ? "Edit automation" : "New automation"} className="confirm-dialog scheduling-dialog" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => void save(event)}>
      <header><h2>{job ? "Edit automation" : "New automation"}</h2><p>Each run starts a thread with the runtime's normal access and approvals.</p></header>
      <label>Name<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label>Prompt<textarea required rows={4} maxLength={16384} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} /></label>
      <label>Project<select required disabled={busy} value={workspace} onChange={(event) => setWorkspace(event.target.value)}><option value="">Select project</option>{!projects.some((project) => project.path === workspace) && workspace ? <option value={workspace}>{workspace.split(/[\\/]/u).pop()}</option> : null}{projects.map((project) => <option key={project.workspaceId ?? project.path} value={project.path}>{project.name}</option>)}</select></label>
      <fieldset className="scheduling-runtimes" role="radiogroup" aria-label="Runtime" onKeyDown={runtimeKey}><legend>Runtime</legend>{choices.map((runtime) => <button key={runtime.kind} type="button" role="radio" tabIndex={backend === runtime.kind ? 0 : -1} aria-checked={backend === runtime.kind} aria-label={runtime.label} disabled={busy} {...tooltipProps(runtime.label)} onClick={() => setBackend(runtime.kind)}><ProviderIconStack runtimeProvider={runtime.kind} runtimeName={runtime.label} /></button>)}</fieldset>
      <label>When<select value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as Schedule["kind"])}><option value="daily">Every day</option><option value="once">Once</option><option value="webhook" disabled={!state.secretStore}>On webhook</option></select></label>
      {kind !== "webhook" ? <div className="scheduling-time">{kind === "once" ? <label>Date in UTC<input type="date" required value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} /></label> : null}<label>Time in UTC<input type="time" required value={time} disabled={busy} onChange={(event) => setTime(event.target.value)} /></label><small>{Number.isFinite(localTime.getTime()) ? `On ${localTime.toLocaleDateString()}, ${localTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })} locally. UTC stays fixed when clocks change.` : "Choose a date and time."}</small></div> : <label>Webhook signature key<input className="scheduling-private-field" type="password" autoComplete="new-password" maxLength={8192} spellCheck={false} disabled={busy || !state.secretStore} required={!hasSavedKey} placeholder={hasSavedKey ? "Saved privately. Leave empty to keep it." : "Paste the secret"} value={secret} onChange={(event) => setSecret(event.target.value)} /><small>{state.secretStore ? `Stored in ${state.secretStore}. Used only to verify this webhook. Never included in the conversation.` : "This host has no supported operating-system secret store."}</small></label>}
      <label className="scheduling-checkbox"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />Start {kind === "webhook" ? "on signed delivery" : "on schedule"}</label>
      {error ? <p className="scheduling-error" role="alert">{error}</p> : null}
      {created && !job && error ? <p className="scheduling-note">The automation was saved but remains off. Retry updates this automation.</p> : null}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !state.canManage || (kind === "webhook" && !state.secretStore)}>{busy ? "Saving…" : "Save automation"}</button></footer>
    </form>
  </Dialog>, document.body);
}
