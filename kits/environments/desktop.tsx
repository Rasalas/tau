import { useEffect, useRef } from "react";
import { Network } from "lucide-react";
import { getClientStorage, type DesktopExtension, type EnvironmentTarget, type PlatformEnvironments, type WorkbenchActions } from "tau";
import { followArrival, readPendingArrival } from "./machines.js";
import { ENVIRONMENTS_EXTENSION_ID, MACHINES_SETTINGS_PAGE, WORKSPACE_STORE_SERVICE, type WorkspaceRailSlice } from "./protocol.js";
import { createMachinesRailSection, createShownMachine } from "./rail.js";
import { createRunOnControl } from "./run-on.js";
import { createMachinesPage } from "./settings.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where an arrival waits until it is placed: a first start's setup, or a reload during it, must not lose a draft. */
export const ARRIVAL_KEY = "tau.environments.arrival";

/**
 * The rail section, plus opening what the page was sent to this machine for.
 * The rail is mounted only while the workbench shows, so the arrival is
 * followed then, and again each time the workbench comes back, until placed.
 */
export function createRailSection(environments: PlatformEnvironments, pause = wait) {
  const Section = createMachinesRailSection(environments);
  let taken = false;
  return function MachinesRail({ actions }: { actions: WorkbenchActions }) {
    const latest = useRef(actions);
    latest.current = actions;
    // Once per mount: the rail mounts again when the workbench comes back, not when the actions change.
    useEffect(() => {
      const current = latest.current;
      let shown = true;
      const storage = getClientStorage();
      // The machine this page shows; unknown before the window's list arrived, and then any will do.
      const machine = () => environments.getSnapshot()?.shown ?? "";
      const follow = (target: EnvironmentTarget | undefined) => {
        if (!target || !shown) return;
        void followArrival(target, { actions: current, wait: pause, shown: () => shown })
          // A thread that never showed up is let go; a draft waits for the next time.
          .then((placed) => { if (placed || (shown && "thread" in target)) storage?.remove(ARRIVAL_KEY); }, () => undefined);
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
      return () => { shown = false; };
    }, []);
    return <Section actions={actions} />;
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
    // A client without a window process (a browser, a phone) has no machines.
    const environments = context.environments;
    if (!environments) return;
    context.registerSettingsPage({
      id: MACHINES_SETTINGS_PAGE,
      label: "Machines",
      Icon: Network,
      order: 45,
      profiles: ["desktop"],
      keywords: ["environments", "computers", "remote", "hosts", "add machine", "pair"],
      Component: createMachinesPage(environments, context.host),
    });
    context.registerCommand({
      id: "environments.add",
      label: "Add a machine…",
      group: "Machines",
      access: "read",
      run: (actions) => actions.openSettings(MACHINES_SETTINGS_PAGE),
    });
    context.registerRegion({ id: "environments.shown", placement: "title-bar", order: 0, profiles: ["desktop"], Component: createShownMachine(environments) });
    context.registerComposerControl({ id: "environments.run-on", placement: "toolbar", order: 5, profiles: ["desktop"], Component: createRunOnControl(environments) });
    const RailSection = createRailSection(environments);
    context.useService<WorkspaceRailSlice>(WORKSPACE_STORE_SERVICE, (store) => store.registerRailSection?.(RailSection));
  },
};

export default environmentsExtension;
