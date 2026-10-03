import { useEffect, useSyncExternalStore } from "react";
import { Network } from "lucide-react";
import { getClientStorage, type DesktopExtension, type EnvironmentTarget, type PlatformEnvironments, type WorkbenchActions } from "tau";
import { createAutoRunOnHook } from "./auto.js";
import { createBringChoice, createBringProjectHook, createProjectIdentities, REMOTE_WORK_EXTENSION_ID } from "./bring-project.js";
import { followArrival, readPendingArrival } from "./machines.js";
import { ENVIRONMENTS_EXTENSION_ID, MACHINES_SETTINGS_PAGE, MACHINE_IMPORT_SERVICE, REMOTE_AGENT_THREADS_SERVICE, RUN_ON_DEFAULT_KEY, WORKSPACE_STORE_SERVICE, type MachineImportProps, type MachineImportService, type RemoteAgentThreadsService, type RunOnDefault, type WorkspaceRailSlice } from "./protocol.js";
import { agentThreadsSource, createMachineCardRow, createMachineThreads, createShownMachine } from "./rail.js";
import { createListHead, hereOf } from "./list-head.js";
import { createRunOnSource, RunOnDefaultRow } from "./run-on.js";
import { createMachinesPage } from "./settings.js";
import { createMachineToolsSection } from "./runtime-tools-section.js";
import { createPhoneMachinesPage } from "./phone-machines.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where an arrival waits until it is placed: a first start's setup, or a reload during it, must not lose a draft. */
export const ARRIVAL_KEY = "tau.environments.arrival";

/**
 * Opens what the page was sent to this machine for; draws nothing (the other
 * machines' threads stand in the rail's own list). The rail is mounted only
 * while the workbench shows, so the arrival is followed then, and again each
 * time the workbench comes back, until placed.
 */
export function createRailSection(environments: PlatformEnvironments, pause = wait, options: { outlivesMount?: boolean } = {}) {
  let taken = false;
  let following = false;
  // The actions of the latest render of any mount: a render's own read that render's state (a draft opening).
  let latest: WorkbenchActions | undefined;
  const current = new Proxy({} as WorkbenchActions, { get: (_target, key) => latest ? Reflect.get(latest, key) : undefined });
  return function MachinesRail({ actions }: { actions: WorkbenchActions }) {
    latest = actions;
    // Once per mount: the rail mounts again when the workbench comes back, not when the actions change.
    useEffect(() => {
      let shown = true;
      const storage = getClientStorage();
      // The machine this page shows; unknown before the window's list arrived, and then any will do.
      const machine = () => environments.getSnapshot()?.shown ?? "";
      const follow = (target: EnvironmentTarget | undefined) => {
        if (!target || !shown || following) return;
        following = true;
        void followArrival(target, { actions: current, wait: pause, shown: () => shown })
          // A thread that never showed up is let go; a draft waits for the next time.
          .then((placed) => { if (placed || (shown && "thread" in target)) storage?.remove(ARRIVAL_KEY); }, () => undefined)
          .finally(() => { following = false; });
      };
      const stored = () => {
        const pending = readPendingArrival(storage?.get(ARRIVAL_KEY));
        return pending && (!pending.machine || !machine() || pending.machine === machine()) ? pending.target : undefined;
      };
      if (taken) follow(stored());
      else {
        taken = true;
        void environments.takeArrival().then((target) => {
          if (target) storage?.set(ARRIVAL_KEY, JSON.stringify({ machine: machine(), target }));
          follow(target ?? stored());
        }, () => follow(stored()));
      }
      // A phone's list gives way to the draft the arrival opens; the arrival goes on regardless.
      return () => { if (!options.outlivesMount) shown = false; };
    }, []);
    return null;
  };
}

/**
 * Machines Kit (ADR 0025): the other computers this window knows, beside this
 * one's threads. It draws what the window's process keeps (the list, each
 * machine's status and threads); the process pairs, pins and connects.
 */
export const environmentsExtension: DesktopExtension = {
  id: ENVIRONMENTS_EXTENSION_ID,
  name: "Machines",
  activate(context) {
    context.registerSettingsSection({ id: "environments.agent-tools", page: "runtimes", profiles: ["desktop", "web", "compact"],
      Component: createMachineToolsSection(context.host), rows: [{ id: "setting-machine-agent-tools", label: "Agent tools across machines", keywords: ["update", "provider", "runtime", "retry", "machines"] }] });
    // A client without a window process (a browser, a phone) has no machines.
    const environments = context.environments;
    if (!environments) return;
    let machineImport: MachineImportService | undefined;
    const listeners = new Set<() => void>();
    context.useService<MachineImportService>(MACHINE_IMPORT_SERVICE, (service) => {
      machineImport = service;
      for (const listener of listeners) listener();
      return () => {
        machineImport = undefined;
        for (const listener of listeners) listener();
      };
    });
    const subscribeImport = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    function ImportConversations(props: MachineImportProps) {
      const service = useSyncExternalStore(subscribeImport, () => machineImport);
      return service ? <service.Component {...props} /> : null;
    }
    context.registerSettingsPage({
      id: MACHINES_SETTINGS_PAGE,
      label: "Machines",
      description: "Other computers that run threads for you, over Tau's encrypted connection, and how to add one.",
      group: "remote",
      Icon: Network,
      order: 45,
      profiles: ["desktop"],
      keywords: ["environments", "computers", "remote", "hosts", "add machine", "pair"],
      Component: createMachinesPage(environments, context.host, ImportConversations),
    });
    // A phone lists the machines it paired with and shows another from there (design 1t).
    context.registerSettingsPage({
      id: MACHINES_SETTINGS_PAGE,
      label: "Machines",
      group: "general",
      Icon: Network,
      order: -1,
      profiles: ["compact"],
      // "2 online" beside it in the list.
      useSummary: () => useSyncExternalStore(environments.subscribe, () => `${environments.getSnapshot()?.environments.filter((machine) => machine.status === "connected").length ?? 0} online`),
      Component: createPhoneMachinesPage(environments),
    });
    context.registerCommand({
      id: "environments.add",
      label: "Add a machine…",
      group: "Machines",
      access: "read",
      run: (actions) => actions.openSettings(MACHINES_SETTINGS_PAGE),
    });
    context.registerRegion({ id: "environments.shown", placement: "title-bar", order: 0, profiles: ["desktop"], Component: createShownMachine(environments) });
    // A machine without the draft's project gets it from Remote Work Kit when the prompt is sent.
    const remoteWork = context.hostExtension(REMOTE_WORK_EXTENSION_ID);
    const bringing = { identities: createProjectIdentities(environments, remoteWork), choice: createBringChoice() };
    const runOnHook = createBringProjectHook(bringing.choice, remoteWork, environments, context.host);
    context.registerPromptHook(createAutoRunOnHook(environments, context.host, bringing.identities, { choice: bringing.choice, hook: runOnHook }));
    context.registerPromptHook(runOnHook);
    const ArrivalRail = createRailSection(environments);
    const threads = createMachineThreads(environments, context.host);
    function RailSection(props: { actions: WorkbenchActions }) {
      threads.useOwnThreads();
      return <ArrivalRail {...props} />;
    }
    const MachineCardRow = createMachineCardRow(environments);
    const runOnSource = createRunOnSource(environments, context.host, bringing, () => context.preferences.value(ENVIRONMENTS_EXTENSION_ID, RUN_ON_DEFAULT_KEY) as RunOnDefault);
    context.registerSettingsSection({ id: "environments.run-on", page: "general", card: "new-threads", order: 10, profiles: ["desktop"], Component: RunOnDefaultRow,
      rows: [{ id: "setting-run-on", label: "Run on", keywords: ["machine", "ask", "this machine", "last used", "new threads"] }] });
    // A phone or tablet lists them in its own thread list, and says there which machine is out of reach (API 1.30.0).
    context.registerThreadListSource?.({ id: "environments.threads", subscribe: threads.subscribe, threads: threads.threads, here: hereOf(environments) });
    // The arrival follows from the list or from a draft the phone reopened, whichever mounts first.
    const ArrivalPhone = createRailSection(environments, wait, { outlivesMount: true });
    function PhoneArrival(props: { actions: WorkbenchActions }) {
      threads.useOwnThreads();
      return <ArrivalPhone {...props} />;
    }
    context.registerRegion({ id: "environments.list-head", placement: "thread-list-head", order: 0, profiles: ["compact"], Component: createListHead(environments, PhoneArrival) });
    context.registerRegion({ id: "environments.arrival", placement: "draft-actions", order: 99, profiles: ["compact"], Component: PhoneArrival });
    context.useService<WorkspaceRailSlice>(WORKSPACE_STORE_SERVICE, (store) => {
      const section = store.registerRailSection?.(RailSection);
      const listed = store.registerRailThreads?.(threads);
      const card = store.registerThreadCardSection?.({ place: "row", order: 20, Component: MachineCardRow });
      // A new thread's machine, in Workspace Kit's Run-on pill before the model (design 1k/1o).
      const runOn = store.registerDraftMachine?.(runOnSource);
      return () => { section?.(); listed?.(); card?.(); runOn?.(); };
    });
    context.useService<RemoteAgentThreadsService>(REMOTE_AGENT_THREADS_SERVICE, (service) => {
      agentThreadsSource.set(service);
      return () => agentThreadsSource.set(undefined);
    });
  },
};

export default environmentsExtension;
