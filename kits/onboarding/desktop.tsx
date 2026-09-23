import { useEffect } from "react";
import { getClientStorage, type DesktopExtension, type DesktopExtensionContext, type RegionProps } from "tau";
import { WelcomeFlow } from "./flow.js";
import { ONBOARDING_EXTENSION_ID as ID, WELCOME_OVERLAY, type WelcomeState } from "./protocol.js";
import { createWelcomeWizard, type TerminalRunner } from "./wizard.js";

/** Terminal Kit's run service (`kits/terminal/protocol.ts`), named here: a kit never imports another. */
const TERMINAL_RUN_SERVICE = "tau.terminal/run";

/**
 * Draws nothing: once per window it reopens a wizard a reload interrupted, or
 * asks whether this is a first start — no thread yet and setup never
 * finished — and opens the wizard if so.
 */
function createFirstStart(context: DesktopExtensionContext, flow: WelcomeFlow) {
  let asked = false;
  // The host counts Pi's sessions; the index also lists other runtimes' threads.
  let threads: number | undefined;
  context.events.on("thread-index", (event) => { threads = event.threadIndex.sessions.length; });
  return function FirstStart({ actions }: RegionProps) {
    useEffect(() => {
      if (asked) return;
      asked = true;
      if (flow.interrupted()) { actions.openOverlay(WELCOME_OVERLAY); return; }
      void context.host.invoke("state").then((state) => {
        if ((state as WelcomeState).firstStart && !threads) actions.openOverlay(WELCOME_OVERLAY);
      }, () => undefined);
    }, [actions]);
    return null;
  };
}

const onboarding: DesktopExtension = {
  id: ID,
  name: "Onboarding",
  activate(context) {
    const flow = new WelcomeFlow(context.host, (id) => context.hostExtension(id), getClientStorage);
    const open = (actions: { openOverlay(id: string): void }) => { flow.start(true); actions.openOverlay(WELCOME_OVERLAY); };
    // A runtime whose login runs in a terminal gets one the user sees, when Terminal Kit is there.
    let runner: TerminalRunner | undefined;
    context.useService<TerminalRunner>(TERMINAL_RUN_SERVICE, (service) => {
      runner = service;
      return () => { if (runner === service) runner = undefined; };
    });
    context.registerOverlay({ id: WELCOME_OVERLAY, profiles: ["desktop"], Component: createWelcomeWizard(flow, () => runner) });
    context.registerRegion({ id: "onboarding.first-start", placement: "title-bar", profiles: ["desktop"], Component: createFirstStart(context, flow) });
    context.registerSlashCommand({ name: "welcome", description: "Set up Tau: agents, projects and earlier conversations", run: (_args, actions) => { open(actions); } });
    context.registerCommand({ id: "onboarding.welcome", label: "Set up Tau…", group: "Workbench", run: open });
  },
};

export default onboarding;
