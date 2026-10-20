import { useSyncExternalStore } from "react";
import { Badge, Button, errorMessage, hostIsReadOnly, SettingsSection, SettingRow, type PlatformEnvironments, type UpdateCoordinator } from "tau";
import { buildUpdatePlan, runUpdatePlan, type UpdateStep } from "./update-plan.js";

/** The run belongs to the extension, so leaving Settings does not interrupt it. */
export function createUpdatePlanSection(environments: PlatformEnvironments, shared?: UpdateCoordinator) {
  if (shared) return function SharedUpdatePlanSection() {
    const state = useSyncExternalStore(shared.subscribe, shared.getSnapshot);
    const readOnly = hostIsReadOnly();
    return <SettingsSection title="Update everything" id="setting-update-everything" headerAction={<Button disabled={readOnly || state.busy || state.reading} onClick={() => void shared.review()}>Review updates</Button>}>
      <SettingRow title="Tools, machines, then this app" description="The same update run as the sidebar. Running work finishes first; this app restarts last." />
      <ol className="machine-update-plan" aria-label="Update plan">{state.steps.map((step) => <li key={`${step.machine}-${step.kind}`}><SettingRow title={<>{step.label} <Badge tone={step.state === "failed" ? "danger" : step.state === "done" ? "success" : "neutral"}>{step.state === "queued" ? "When online" : step.state}</Badge></>} description={step.message} control={step.state === "queued" && shared.cancelQueued ? <Button disabled={readOnly || state.busy || state.reading} onClick={() => void shared.cancelQueued!(step.machine)}>Cancel queued update</Button> : undefined} /></li>)}</ol>
      {!state.started && state.steps.some((step) => step.state === "pending" || step.deferUntilOnline) ? <Button disabled={readOnly || state.busy || state.reading} onClick={() => void shared.run(true)}>Run update plan</Button> : null}
      {state.steps.some((step) => step.uncertain) ? <Button onClick={() => void shared.check()}>Check results</Button> : null}
      {state.problem ? <p role="alert">{state.problem}</p> : null}
    </SettingsSection>;
  };
  let view: { steps?: UpdateStep[]; busy: boolean; started: boolean; problem?: string } = { busy: false, started: false };
  const listeners = new Set<() => void>();
  const changed = () => { view = { ...view }; for (const listener of listeners) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const review = async () => {
    if (view.busy) return;
    view = { busy: true, started: false };
    changed();
    try { view.steps = await buildUpdatePlan(environments, { changed: (steps) => { view = { ...view, steps }; changed(); } }); }
    catch (error) { view.problem = errorMessage(error); }
    finally { view.busy = false; changed(); }
  };
  const run = async () => {
    if (view.busy || !view.steps) return;
    view.busy = true;
    view.started = true;
    changed();
    try { await runUpdatePlan(view.steps, environments, { changed }); }
    finally { view.busy = false; changed(); }
  };
  return function UpdatePlanSection() {
    const state = useSyncExternalStore(subscribe, () => view);
    const readOnly = hostIsReadOnly();
    return <SettingsSection title="Update everything" id="setting-update-everything"
      headerAction={<Button disabled={readOnly || state.busy} busy={state.busy && !state.started} onClick={() => void review()}>Review updates</Button>}>
      <SettingRow title="Tools, machines, then this app" description="Review the available updates before starting. Each machine waits for running turns and required background work. This app restarts last." />
      {state.steps ? <ol className="machine-update-plan" aria-label="Update plan">
        {state.steps.map((step, index) => <li key={`${step.machine}-${step.kind}`}>
          <SettingRow title={<>{index + 1}. {step.label} <Badge tone={step.state === "failed" ? "danger" : step.state === "done" ? "success" : "neutral"}>{step.state}</Badge></>}
            description={<span role={step.state === "failed" ? "alert" : "status"}>{step.message}</span>} />
        </li>)}
      </ol> : null}
      {state.steps?.length === 0 && !state.busy ? <p className="settings-group-note">No available updates on the connected machines.</p> : null}
      {state.steps?.some((step) => step.state === "pending") && !state.started ? <Button variant="primary" disabled={readOnly || state.busy} onClick={() => void run()}>Run update plan</Button> : null}
      {state.problem ? <p role="alert">{state.problem}</p> : null}
    </SettingsSection>;
  };
}
