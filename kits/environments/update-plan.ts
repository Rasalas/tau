import { compareVersions, describeHostUpdate, errorMessage, hostUpdatePending, type HostUpdateStatus, type PlatformEnvironments, type UiEnvironment, type UiRuntimeTool, type UiRuntimeToolsState, type UpdateStep } from "tau";
import { ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE, LOCAL_UPDATE_SELECTED } from "./protocol.js";

export type { UpdateStep } from "tau";

const active = (state: UiRuntimeToolsState) => state.tools.some((tool) => tool.state);
const pending = (tool: UiRuntimeTool) => Boolean(tool.update && tool.installed && tool.latest && compareVersions(tool.installed, tool.latest) < 0);
const readTools = (environments: PlatformEnvironments, machine: string) => environments.readExtension!(machine, ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE) as Promise<UiRuntimeToolsState>;
const unavailable = (machine: UiEnvironment) => machine.readOnly ? "Read only" : machine.status !== "connected" ? machine.status === "refused" ? "Connection refused" : "Disconnected" : undefined;
export const canDeferUpdate = (machine: UiEnvironment) => !machine.local && !machine.readOnly && (machine.status === "offline" || machine.status === "connecting") && machine.update?.devicesMayInstall !== false;

interface PlanOptions {
  machine?: string;
  /** Called with a fresh list whenever a machine's read settles. */
  changed?(steps: UpdateStep[]): void;
  /** How long one machine may take to answer before its row is dropped from the run. */
  timeoutMs?: number;
}

/** A machine that does not answer in this time is listed as unread and left out of the run. */
const READ_TIMEOUT_MS = 10_000;

const withTimeout = <T,>(promise: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Did not answer in time. Review again to include this machine.")), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

/** Reads only: the list is reviewed before any update request is sent. Rows appear as each machine answers. */
export async function buildUpdatePlan(environments: PlatformEnvironments, options: PlanOptions = {}): Promise<UpdateStep[]> {
  const machines = environments.getSnapshot()?.environments.filter((machine) => !options.machine || machine.id === options.machine);
  if (!machines) throw new Error("The machine list has not loaded yet.");
  const updates = machines.filter((machine) => !canDeferUpdate(machine) && hostUpdatePending(machine.update)).map((machine): UpdateStep => {
    const reason = unavailable(machine) ?? (!environments.update ? "This client cannot update machines." : !machine.local && !machine.update!.devicesMayInstall ? "The owner does not allow this device to install updates." : undefined);
    const app = machine.local;
    return { machine: machine.id, machineName: machine.name, fromVersion: machine.update!.version, kind: app ? "app" : "machine", label: `${machine.name}: ${app ? "Tau and this app, last" : "Tau"} → ${machine.update!.latest}`,
      version: machine.update!.latest, state: reason ? "skipped" : "pending", ...(reason ? { message: reason } : {}) };
  });
  // One slot per machine, undefined once its read shows nothing to update.
  const rows: (UpdateStep | undefined)[] = machines.map((machine) => {
    const base = { machine: machine.id, machineName: machine.name, label: `${machine.name}: agent tools`, kind: "tools" as const };
    if (canDeferUpdate(machine)) return { ...base, kind: "machine", label: `${machine.name}: update when online`, state: "skipped", deferUntilOnline: true, message: "Will update when online" };
    const reason = unavailable(machine);
    if (reason) return { ...base, state: "skipped", message: reason };
    if (!environments.readExtension || !environments.invokeExtension) return { ...base, state: "skipped", message: "This client cannot manage tools on this machine." };
    return { ...base, state: "reading", message: "Reading agent tools…" };
  });
  const snapshot = () => [...rows.filter((step): step is UpdateStep => Boolean(step)), ...updates.filter((step) => step.kind === "machine"), ...updates.filter((step) => step.kind === "app")];
  options.changed?.(snapshot());
  await Promise.all(machines.map(async (machine, index) => {
    const row = rows[index];
    if (row?.state !== "reading") return;
    try {
      const state = await withTimeout(readTools(environments, machine.id), options.timeoutMs ?? READ_TIMEOUT_MS);
      const selected = state.blocked ? [] : state.tools.filter((tool) => pending(tool) || tool.state);
      rows[index] = state.blocked ? { ...row, state: "skipped", message: state.blocked }
        : selected.length ? { ...row, tools: selected, state: "pending", message: selected.map((tool) => `${tool.label} ${tool.installed ?? "unknown"} → ${tool.latest ?? "unknown"}`).join(", ") } : undefined;
    } catch (error) {
      rows[index] = { ...row, state: "skipped", message: errorMessage(error) };
    }
    options.changed?.(snapshot());
  }));
  return snapshot();
}

interface RunOptions {
  resumeInterrupted?: boolean;
  deferOffline?: boolean;
  cancelled?(): boolean;
  changed(): void;
  pause?: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/** Waits for completion, including queued maintenance, before requesting any restart. */
export async function runUpdatePlan(steps: UpdateStep[], environments: PlatformEnvironments, options: RunOptions): Promise<void> {
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 2_000)));
  const now = options.now ?? Date.now;
  const blocked = new Set(steps.filter((step) => step.kind === "tools" && step.state === "skipped").map((step) => step.machine));
  let unsettled = false;
  const report = (step: UpdateStep, message: string) => { step.message = message; options.changed(); };
  // Also enforce the order when a caller passes an unsorted plan.
  const order = { tools: 0, machine: 1, app: 2 };
  for (const step of [...steps].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (options.cancelled?.()) return;
    if (step.state !== "pending") continue;
    const before = environments.getSnapshot()?.environments.find((machine) => machine.id === step.machine);
    if (options.deferOffline && before && canDeferUpdate(before)) {
      step.state = "queued"; step.deferUntilOnline = true;
      report(step, "Updates when connected");
      continue;
    }
    if (step.kind !== "tools" && (blocked.has(step.machine) || (step.kind === "app" && unsettled))) {
      step.state = "skipped";
      report(step, "An earlier update could not be verified. Review its result before restarting.");
      continue;
    }
    step.state = "running";
    options.changed();
    if (options.cancelled?.()) return;
    const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
    const wait = async () => {
      if (options.cancelled?.()) throw new Error("The update view closed. Check the result before continuing.");
      if (now() >= deadline) throw new Error("Still waiting for completion. Check this machine before trying again.");
      await pause();
    };
    let mayBeRunning = false;
    try {
      const machine = environments.getSnapshot()?.environments.find((entry) => entry.id === step.machine);
      if (!machine || unavailable(machine)) throw new Error(machine ? unavailable(machine)! : "This machine is no longer saved.");
      if (step.kind === "tools") {
        let state = await readTools(environments, step.machine);
        mayBeRunning = active(state);
        // A previous request may still own the updater. Never replay it.
        while (active(state)) {
          report(step, "Waiting for agent tool updates and running turns…");
          await wait();
          state = await readTools(environments, step.machine);
        }
        mayBeRunning = false;
        if (state.blocked) throw new Error(state.blocked);
        const kinds = (step.tools ?? []).filter((tool) => !tool.state).flatMap((tool) => tool.kinds);
        if (kinds.length) {
          mayBeRunning = true;
          state = await environments.invokeExtension!(step.machine, ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED, { kinds }, { timeoutMs: 120_000 }) as UiRuntimeToolsState;
        }
        while (active(state)) {
          report(step, state.tools.some((tool) => tool.state === "waiting") ? "Waiting for running turns before updating tools…" : "Updating agent tools…");
          await wait();
          state = await readTools(environments, step.machine);
        }
        mayBeRunning = false;
        const remaining = (step.tools ?? []).filter((tool) => {
          const current = state.tools.find((entry) => entry.kinds.some((kind) => tool.kinds.includes(kind)));
          return !current?.installed || !tool.latest || compareVersions(current.installed, tool.latest) < 0;
        });
        if (remaining.length) throw new Error(remaining.map((tool) => `${tool.label}: ${state.log.find((entry) => entry.label === tool.label)?.message ?? "The expected version was not installed."}`).join(" "));
      } else {
        mayBeRunning = true;
        let status: HostUpdateStatus | undefined = await environments.update!(step.machine, options.resumeInterrupted === undefined ? "install" : { install: true, resumeInterrupted: options.resumeInterrupted });
        while (true) {
          if (status?.phase === "failed" || status?.phase === "unsupported") {
            mayBeRunning = false;
            throw new Error(describeHostUpdate(status));
          }
          if (status && (status.phase === "installed" || compareVersions(status.version, step.version!) >= 0 || (step.kind === "app" && status.phase === "installing"))) break;
          if (status && ["ready", "available", "current", "idle"].includes(status.phase)) {
            mayBeRunning = false;
            throw new Error(status.reason ?? "The update did not start. Review this machine before trying again.");
          }
          report(step, status ? describeHostUpdate(status) : "Waiting for the machine to reconnect…");
          await wait();
          const current = environments.getSnapshot()?.environments.find((entry) => entry.id === step.machine);
          status = current?.status === "connected" ? current.update : undefined;
        }
      }
      // An app restart acknowledgement is not proof that the new process is running yet.
      step.state = step.kind === "app" ? "running" : "done";
      report(step, step.kind === "app" ? "Restarting into the update…" : "Done");
    } catch (error) {
      step.state = "failed";
      const unsupported = (error as { code?: string })?.code === "unknown-command";
      if (unsupported) mayBeRunning = false;
      if (mayBeRunning) { blocked.add(step.machine); unsettled = true; step.uncertain = true; }
      report(step, unsupported ? "Update Tau on this machine before updating the selected tools." : errorMessage(error));
    }
  }
}
