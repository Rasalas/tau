import { useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Check, ChevronRight, Clock3, LoaderCircle, RefreshCw, Server, TriangleAlert } from "lucide-react";
import { compareVersions, errorMessage, Sheet, Switch, UpdateNotes, useClientEnvironment, type UpdateCoordinator, type UpdateStep } from "tau";

const queued = (step: UpdateStep) => step.state === "queued";

/** One touch flow for the Machines page and the update notice above the phone's threads. */
export function PhoneUpdates({ updates, notice = false }: { updates: UpdateCoordinator; notice?: boolean }) {
  const view = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const { mobileApp } = useClientEnvironment();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<{ version: string; fromVersion: string | undefined }>();
  const [resume, setResume] = useState(true);
  const [problem, setProblem] = useState<string>();
  const machines = [...new Set(view.steps.map((step) => step.machine))].map((id) => {
    const steps = view.steps.filter((step) => step.machine === id);
    const step = steps.find((entry) => entry.state === "failed" || entry.uncertain)
      ?? steps.find((entry) => entry.state === "running" || entry.state === "pending" || queued(entry))
      ?? steps.find((entry) => entry.state === "done") ?? steps[0]!;
    return { id, steps, step };
  });
  const waiting = machines.filter(({ steps }) => steps.some(queued));
  const available = machines.filter(({ steps }) => steps.some((step) => step.state === "pending" || step.deferUntilOnline && step.state === "skipped"));
  const finished = machines.filter(({ steps }) => steps.some((step) => step.state === "done") && steps.every((step) => step.state === "done" || step.state === "skipped" && !step.deferUntilOnline));
  const skipped = machines.filter(({ steps }) => steps.every((step) => step.state === "skipped" && !step.deferUntilOnline));
  const failed = machines.some(({ step }) => step.state === "failed");
  const uncertain = view.steps.some((step) => step.uncertain);
  const busy = view.busy || view.steps.some((step) => step.state === "running");
  const target = view.steps.filter((step) => step.kind !== "tools" && step.version).map((step) => step.version!).sort(compareVersions).at(-1);
  const from = view.steps.flatMap((step) => step.fromVersion ? [step.fromVersion] : []).sort(compareVersions)[0];
  const count = available.length + waiting.length;
  const summary = busy ? `${finished.length} of ${machines.length - skipped.length} updated`
    : waiting.length ? `${waiting.length} waiting for connection`
    : failed ? "Some updates need attention"
    : count ? `${count} machine${count === 1 ? "" : "s"} with updates`
    : view.reading ? "Checking your machines…" : view.steps.some((step) => step.state === "skipped" && !step.deferUntilOnline) ? "Some updates were skipped" : "Up to date";
  const run = async (work: () => Promise<void>) => {
    setProblem(undefined);
    try { await work(); } catch (error) { setProblem(errorMessage(error)); }
  };
  const close = () => { setNotes(undefined); setOpen(false); };
  if (notice && !open && !busy && !count && !failed) return null;
  const Mark = busy || view.reading ? LoaderCircle : failed ? TriangleAlert : waiting.length ? Clock3 : count ? ArrowUpCircle : Check;
  const row = ({ id, steps, step }: typeof machines[number]) => {
    const Icon = step.state === "running" ? LoaderCircle : step.state === "failed" ? TriangleAlert : step.state === "done" ? Check : Server;
    const detail = step.state === "queued" ? "Updates when connected" : step.message ?? (step.state === "done" ? "Updated" : step.state === "skipped" ? "Skipped" : step.kind === "tools" ? step.tools?.map((tool) => tool.label).join(", ") : `${step.fromVersion ?? ""} → ${step.version ?? ""}`);
    const tools = steps.find((entry) => entry.kind === "tools");
    const skippedParts = steps.filter((entry) => entry !== step && entry.state === "skipped" && !entry.deferUntilOnline);
    return <li key={id} className="phone-update-machine" data-state={step.state}>
      <Icon size={19} className={step.state === "running" ? "update-spin" : undefined} />
      <div><strong>{step.machineName ?? id}</strong><span>{detail}</span>{skippedParts.map((part) => <small key={part.kind}>{part.kind === "tools" ? "Agent tools" : "Tau"} skipped{part.message ? `: ${part.message}` : ""}</small>)}{!skippedParts.length && tools && step.kind !== "tools" ? <small>Includes agent tools</small> : null}</div>
      {step.state === "queued" && updates.cancelQueued ? <button type="button" disabled={busy || view.reading} aria-label={`Cancel update for ${step.machineName ?? id}`} onClick={() => void run(() => updates.cancelQueued!(id))}>Cancel</button>
        : step.state === "failed" ? <button type="button" disabled={busy || view.reading} onClick={() => void run(() => step.uncertain ? updates.check() : updates.retry?.(id) ?? updates.review())}>{step.uncertain ? "Check" : "Retry"}</button> : null}
    </li>;
  };
  return <>
    <button type="button" className={`phone-updates-entry${notice ? " phone-updates-notice" : ""}`} aria-label={`Machine updates: ${summary}`} onClick={() => { setOpen(true); }}>
      <Mark size={21} className={busy || view.reading ? "update-spin" : undefined} /><span><strong>Machine updates</strong><small>{summary}</small></span><ChevronRight size={18} />
    </button>
    {open ? <Sheet title="Machine updates" presentation="page" className="phone-updates" onClose={close}>
      <div className="phone-updates-overview">
        <div className="phone-updates-heading"><h2>{busy ? "Updating your machines" : waiting.length ? "Ready when they reconnect" : failed ? "A few updates need attention" : count ? "Ready to update" : view.reading ? "Checking for updates" : view.started && finished.length ? "Updates finished" : skipped.length ? "No updates ready" : "All up to date"}</h2><p>{busy ? "Running work finishes before each machine restarts." : waiting.length ? "Queued machines update when they reconnect." : "Tau and agent tools on your connected machines."}</p></div>
        {target ? <button type="button" className="phone-updates-changelog" onClick={() => setNotes({ version: target, fromVersion: from })}><span><strong>What’s new in {target}</strong><small>Read the changes before updating</small></span><ChevronRight size={18} /></button> : null}
        {machines.length ? <ul className="phone-updates-machines" aria-label="Updates by machine">{machines.filter((machine) => !finished.includes(machine) && !skipped.includes(machine) && !waiting.includes(machine)).map(row)}</ul> : null}
        {waiting.length ? <section className="phone-updates-group"><h3>When online <span>{waiting.length}</span></h3><ul>{waiting.map(row)}</ul></section> : null}
        {([['Updated', finished], ['Skipped', skipped]] as const).map(([label, entries]) => entries.length ? <details className="phone-updates-group" key={label}><summary>{label}<span>{entries.length}</span><ChevronRight size={17} /></summary><ul>{entries.map(row)}</ul></details> : null)}
        {mobileApp ? <p className="phone-updates-app-note">This updates your machines. The {mobileApp.platform === "ios" ? "App Store or TestFlight" : "Play Store"} updates this phone’s app.</p> : null}
        {(problem ?? view.problem) ? <p className="phone-updates-error" role="alert">{problem ?? view.problem}</p> : null}
      </div>
      <footer className="phone-updates-footer">
        {!view.started && count ? <div className="phone-updates-resume"><span>Resume interrupted threads<small>For this update only</small></span><Switch label="Resume interrupted threads" checked={resume} disabled={busy || view.reading} onChange={setResume} /></div> : null}
        {uncertain ? <button type="button" className="phone-updates-primary" disabled={busy || view.reading} onClick={() => void run(updates.check)}>Check results</button>
          : !view.started && available.length ? <button type="button" className="phone-updates-primary" disabled={busy || view.reading} onClick={() => void run(() => updates.run(resume))}><ArrowUpCircle size={19} />{count > 1 ? "Update all" : "Update machine"}</button>
          : busy || waiting.length ? <button type="button" className="phone-updates-primary" onClick={close}>Hide progress</button>
          : <button type="button" className="phone-updates-primary" disabled={view.reading} onClick={() => void run(updates.review)}><RefreshCw size={18} />Check for updates</button>}
        {busy || waiting.length ? <p role="status">{summary}{waiting.length ? ". Keep Tau open." : ""}</p> : null}
      </footer>
      {notes ? <Sheet title="What’s new" presentation="page" className="phone-update-notes" onClose={() => setNotes(undefined)}><UpdateNotes version={notes.version} fromVersion={notes.fromVersion} /></Sheet> : null}
    </Sheet> : null}
  </>;
}
