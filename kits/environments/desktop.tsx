import { useEffect } from "react";
import { Network } from "lucide-react";
import type { DesktopExtension, PlatformEnvironments, WorkbenchActions } from "tau";
import { followArrival } from "./machines.js";
import { ENVIRONMENTS_EXTENSION_ID, MACHINES_SETTINGS_PAGE, WORKSPACE_STORE_SERVICE, type WorkspaceRailSlice } from "./protocol.js";
import { createMachinesRailSection } from "./rail.js";
import { createRunOnControl } from "./run-on.js";
import { createMachinesPage } from "./settings.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The rail section, plus the one-time step of opening what the page was sent to this machine for. */
function createRailSection(environments: PlatformEnvironments) {
  const Section = createMachinesRailSection(environments);
  let arrived = false;
  return function MachinesRail({ actions }: { actions: WorkbenchActions }) {
    useEffect(() => {
      if (arrived) return;
      arrived = true;
      void environments.takeArrival()
        .then((target) => target ? followArrival(target, { actions, wait }) : undefined)
        .catch(() => undefined);
    }, [actions]);
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
      Component: createMachinesPage(environments),
    });
    context.registerCommand({
      id: "environments.add",
      label: "Add a machine…",
      group: "Machines",
      run: (actions) => actions.openSettings(MACHINES_SETTINGS_PAGE),
    });
    context.registerComposerControl({ id: "environments.run-on", placement: "toolbar", order: 5, profiles: ["desktop"], Component: createRunOnControl(environments) });
    const RailSection = createRailSection(environments);
    context.useService<WorkspaceRailSlice>(WORKSPACE_STORE_SERVICE, (store) => store.registerRailSection?.(RailSection));
  },
};

export default environmentsExtension;
