import { compareVersions, errorMessage, getClientStorage, type PlatformEnvironments, type UiRuntimeToolsState, type UpdateCoordinator, type UpdateCenterView, type UpdateStep } from "tau";
import { ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE } from "./protocol.js";
import { buildUpdatePlan, canDeferUpdate, runUpdatePlan } from "./update-plan.js";

function savedRun(source: string | null): { steps: UpdateStep[]; resumeInterrupted: boolean } | undefined {
  try {
    const raw = JSON.parse(source ?? "null");
    const steps = Array.isArray(raw) ? raw : raw?.steps;
    if (!Array.isArray(steps) || steps.length > 200 || !steps.every((step) => step && typeof step.machine === "string" && typeof step.label === "string" && ["tools", "machine", "app"].includes(step.kind) && ["pending", "queued", "running", "done", "failed", "skipped"].includes(step.state)
      && ["message", "version", "fromVersion", "machineName"].every((field) => step[field] === undefined || typeof step[field] === "string")
      && (step.state !== "queued" || step.deferUntilOnline === true)
      && (step.tools === undefined || Array.isArray(step.tools) && step.tools.every((tool: { tool?: unknown; label?: unknown; kinds?: unknown; latest?: unknown }) => tool && typeof tool.tool === "string" && typeof tool.label === "string" && Array.isArray(tool.kinds) && tool.kinds.every((kind: unknown) => typeof kind === "string") && (tool.latest === undefined || typeof tool.latest === "string"))))) return undefined;
    return { resumeInterrupted: typeof raw?.resumeInterrupted === "boolean" ? raw.resumeInterrupted : true,
      steps: steps.map((step: UpdateStep) => step.state === "running" ? { ...step, state: "failed", uncertain: true, message: "Checking the result after reconnecting…" } : step) };
  } catch { return undefined; }
}

/** One persisted run for Settings and the sidebar. Its storage lock also coordinates other windows. */
export function createUpdateController(environments: PlatformEnvironments): UpdateCoordinator & { dispose(): void } {
  const storage = getClientStorage();
  const key = `tau.updates.v1:${environments.shownElsewhere ?? "local"}`;
  let view: UpdateCenterView = { steps: [], busy: false, reading: false, started: false };
  let resumeInterrupted = true;
  let persistenceFailed = false;
  let lastStored: string | null | undefined;
  const listeners = new Set<() => void>();
  let disposed = false;
  let started = false;
  let checking: Promise<void> | undefined;
  const emit = () => { view = { ...view, steps: [...view.steps] }; for (const listener of listeners) listener(); };
  const restore = () => {
    const source = storage?.get(key) ?? null;
    if (source === lastStored) return;
    lastStored = source;
    const saved = savedRun(source);
    resumeInterrupted = saved?.resumeInterrupted ?? true;
    view = { steps: saved?.steps ?? [], busy: false, reading: false, started: Boolean(saved) };
    emit();
  };
  try { restore(); } catch { /* An unreadable saved run never initiates work. */ }
  const changed = () => {
    try {
      if (view.started) { const source = JSON.stringify({ steps: view.steps, resumeInterrupted }); storage?.set(key, source); lastStored = source; }
      else { storage?.remove(key); lastStored = null; }
    } catch { persistenceFailed = true; view.problem = "The update progress could not be saved. Further update requests are held; check the results before continuing."; }
    emit();
  };
  const locked = async (work: () => Promise<void>) => {
    const run = async () => { if (disposed) return; restore(); await work(); };
    try { await (storage?.withLock ? storage.withLock(key, run) : run()); }
    catch (error) { persistenceFailed = true; view.problem = `The saved update run could not be coordinated: ${errorMessage(error)}`; emit(); }
  };
  const held = () => disposed || persistenceFailed;
  const queued = () => view.steps.some((step) => step.state === "queued");
  const unresolved = () => view.steps.some((step) => step.uncertain || step.state === "running");
  const queueOffline = (steps: UpdateStep[]) => {
    for (const step of steps.filter((entry) => entry.deferUntilOnline && entry.state === "skipped")) {
      if (storage?.withLock) { step.state = "queued"; step.message = "Updates when connected"; }
      else { step.deferUntilOnline = false; step.message = "This client cannot save offline updates. Review again when connected."; }
    }
  };
  const runPending = async () => {
    view.busy = true; changed();
    try { await runUpdatePlan(view.steps, environments, { resumeInterrupted, deferOffline: Boolean(storage?.withLock), changed, cancelled: held }); }
    catch (error) { view.problem = errorMessage(error); }
    finally { view.busy = false; changed(); }
  };
  const prepareQueued = async () => {
    // A queued request has never been sent. Read a new plan only once its machine is reachable.
    for (const step of new Map(view.steps.filter((entry) => entry.state === "queued").map((entry) => [entry.machine, entry])).values()) {
      if (held()) return;
      const machine = environments.getSnapshot()?.environments.find((entry) => entry.id === step.machine);
      const blocked = !machine ? "Machine removed. Update cancelled."
        : machine.status === "refused" ? "Connection refused. Review this machine before updating."
        : machine.readOnly ? "Read only. Update cancelled."
        : machine.update?.devicesMayInstall === false ? "The owner no longer allows this device to install updates."
        : view.steps.some((entry) => entry.machine === step.machine && entry.state === "failed") ? "An earlier update failed. Review this machine before updating." : undefined;
      if (blocked) { step.state = "skipped"; step.deferUntilOnline = false; step.message = blocked; changed(); continue; }
      if (machine!.status !== "connected") continue;
      view.reading = true; changed();
      try {
        const fresh = await buildUpdatePlan(environments, { machine: step.machine });
        if (held()) return;
        const current = environments.getSnapshot()?.environments.find((entry) => entry.id === step.machine);
        if (current && canDeferUpdate(current)) continue;
        const unread = fresh.find((entry) => entry.state === "skipped" && !entry.deferUntilOnline);
        if (unread) { step.state = "failed"; step.deferUntilOnline = false; step.version = current?.update?.latest; step.message = unread.message ?? "This machine's updates could not be reviewed."; changed(); continue; }
        view.steps = [...view.steps.filter((entry) => entry.machine !== step.machine), ...(fresh.length ? fresh : [{ ...step, deferUntilOnline: false, state: "done" as const, version: current?.update?.version, message: "Already up to date" }])];
        changed();
      } catch (error) { step.state = "failed"; step.deferUntilOnline = false; step.message = errorMessage(error); changed(); }
      finally { view.reading = false; changed(); }
    }
  };
  const checkResults = async () => {
    if (view.busy || view.reading || held()) return;
    const machines = environments.getSnapshot()?.environments;
    if (!machines) return;
    for (const step of view.steps.filter((entry) => entry.uncertain || entry.state === "running")) {
      const machine = machines.find((entry) => entry.id === step.machine);
      if (!machine || machine.status !== "connected") continue;
      try {
        if (step.kind === "tools") {
          const state = await environments.readExtension!(step.machine, ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE) as UiRuntimeToolsState;
          if (state.tools.some((tool) => tool.state)) continue;
          const complete = step.tools?.every((tool) => state.tools.some((current) => current.kinds.some((kind) => tool.kinds.includes(kind)) && current.installed && tool.latest && compareVersions(current.installed, tool.latest) >= 0));
          step.state = complete ? "done" : "failed";
          step.message = complete ? "Done" : "The tools did not reach the expected version. Review updates to try again.";
        } else {
          const status = machine.update;
          if (!status) continue;
          if (step.version && compareVersions(status.version, step.version) >= 0) { step.state = "done"; step.message = "Updated"; }
          else if (["failed", "ready", "current"].includes(status.phase)) { step.state = "failed"; step.message = status.reason ?? "The expected version is not installed. Review updates to try again."; }
          else continue;
        }
        step.uncertain = false;
        changed();
      } catch { /* Keep a lost response held while disconnected. */ }
    }
    if (!view.started || unresolved() || held()) return;
    if (storage?.withLock) await prepareQueued();
    if (!held() && view.steps.some((step) => step.state === "pending")) await runPending();
  };
  const controller: UpdateCoordinator & { dispose(): void } = {
    getSnapshot: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!started) { started = true; void (view.started ? controller.check() : controller.review()); }
      return () => { listeners.delete(listener); };
    },
    review: () => locked(async () => {
      if (view.busy || view.reading || held() || unresolved() || queued()) { await checkResults(); return; }
      view = { steps: [], busy: false, reading: true, started: false }; changed();
      try {
        const steps = await buildUpdatePlan(environments, { changed: (nextSteps) => { if (!disposed) { view.steps = nextSteps; changed(); } } });
        if (!disposed) view.steps = steps;
      } catch (error) { view.problem = errorMessage(error); }
      finally { view.reading = false; changed(); }
    }),
    async run(resume) {
      await locked(async () => {
        if (view.busy || view.reading || view.started || held() || unresolved()) return;
        resumeInterrupted = resume;
        view = { ...view, started: true, problem: undefined };
        queueOffline(view.steps);
        await runPending();
      });
      if (queued()) void controller.check();
    },
    check: () => checking ??= locked(checkResults).finally(() => { checking = undefined; }),
    retry: (machine) => locked(async () => {
      if (view.busy || view.reading || held()) return;
      await checkResults();
      if (unresolved()) return;
      view.reading = true; changed();
      try {
        const selected = await buildUpdatePlan(environments, { machine });
        queueOffline(selected);
        view.steps = [...view.steps.filter((step) => step.machine !== machine), ...selected];
        view.started = true; view.reading = false;
        await runPending();
      } catch (error) { view.problem = errorMessage(error); }
      finally { view.reading = false; changed(); }
    }),
    cancelQueued: (machine) => locked(async () => {
      if (view.busy || view.reading || held()) return;
      for (const step of view.steps.filter((entry) => entry.machine === machine && entry.state === "queued")) { step.state = "skipped"; step.deferUntilOnline = false; step.message = "Update cancelled"; }
      changed();
    }),
    dispose() { disposed = true; clearInterval(timer); stop(); },
  };
  const refresh = () => {
    if (view.busy || view.reading || disposed) return;
    const newer = environments.getSnapshot()?.environments.some((machine) => machine.update?.latest && compareVersions(machine.update.latest, machine.update.version) > 0 && !view.steps.some((step) => step.machine === machine.id && step.version && compareVersions(machine.update!.latest!, step.version) <= 0));
    void (view.started && (queued() || unresolved() || !newer) ? controller.check() : controller.review());
  };
  const stop = environments.subscribe(refresh);
  const timer = setInterval(refresh, 30_000);
  return controller;
}
