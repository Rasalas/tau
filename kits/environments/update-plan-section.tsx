import { useSyncExternalStore } from "react";
import { Badge, Button, errorMessage, hostIsReadOnly, SettingsSection, SettingRow, type PlatformEnvironments } from "tau";
import { buildUpdatePlan, runUpdatePlan, type UpdateStep } from "./update-plan.js";

/** The run belongs to the extension, so leaving Settings does not interrupt it. */
export function createUpdatePlanSection(environments: PlatformEnvironments) {
  let view: { steps?: UpdateStep[]; busy: boolean; started: boolean; problem?: string } = { busy: false, started: false };
  const listeners = new Set<() => void>();
  const changed = () => { view = { ...view }; for (const listener of listeners) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const review = async () => {
    if (view.busy) return;
    view = { busy: true, started: false };
    changed();
    try { view.steps = await buildUpdatePlan(environments); }
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
      {state.steps?.length === 0 ? <p className="settings-group-note">No available updates on the connected machines.</p> : null}
      {state.steps?.some((step) => step.state === "pending") && !state.started ? <Button variant="primary" disabled={readOnly || state.busy} onClick={() => void run()}>Run update plan</Button> : null}
      {state.problem ? <p role="alert">{state.problem}</p> : null}
    </SettingsSection>;
  };
}
