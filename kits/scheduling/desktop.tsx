import { lazy, Suspense, useSyncExternalStore } from "react";
import { CalendarClock } from "lucide-react";
import type { DesktopExtension } from "tau";
import { SchedulingFeed, needsDecision } from "./feed.js";
import { SCHEDULING_ID } from "./protocol.js";

const Page = lazy(() => import("./page.js"));
const Secrets = lazy(() => import("./secret-card.js"));

const schedulingExtension: DesktopExtension = {
  id: SCHEDULING_ID, name: "Automations",
  activate(plugin) {
    const feed = new SchedulingFeed(plugin.host);
    plugin.registerPage({
      id: "scheduling.automations", label: "Automations", description: "Start a saved prompt at a time or from a signed webhook. Runs use the runtime's normal access and approvals.",
      Icon: CalendarClock, order: 30, layout: "readable", profiles: ["desktop", "web", "compact"], keywords: ["schedule", "daily", "jobs", "webhook"],
      useBadge: () => { const state = useSyncExternalStore(feed.subscribe, feed.get).state; return state ? state.jobs.filter(needsDecision).length + state.secretRequests.filter((request) => request.status === "pending").length : undefined; },
      Component: (props) => <Suspense fallback={<p>Loading automations…</p>}><Page {...props} feed={feed} /></Suspense>,
    });
    plugin.registerCommand({ id: "scheduling.open", label: "Automations", group: "Extensions", access: "read", run: (actions) => actions.openPage?.("scheduling.automations") });
    plugin.registerCommand({ id: "scheduling.new", label: "New automation", group: "Extensions", run: (actions) => actions.openPage?.("scheduling.automations", { create: true }) });
    plugin.registerRegion({ id: "scheduling.private-secret", placement: "composer-above", order: 15, profiles: ["desktop", "web", "compact"], Component: (props) => <Suspense fallback={null}><Secrets {...props} feed={feed} /></Suspense> });
  },
};
export default schedulingExtension;
