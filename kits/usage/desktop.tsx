import { ChartColumn } from "lucide-react";
import type { DesktopExtension } from "tau";
import { UsageSidebar } from "./controls.js";
import { createUsageView } from "./filters.js";
import { JuicebarStrip } from "./juicebar-strip.js";
import { createJuicebarChoices } from "./juicebar-choices.js";
import { Juicebars } from "./juicebars-view.js";
import { MonthCost } from "./month-cost.js";
import { createLimitsFeed } from "./limits-feed.js";
import { UsagePage } from "./page.js";
import { USAGE_EXTENSION_ID, USAGE_PAGE } from "./protocol.js";
import { createWayLine } from "./way-line.js";

/** Usage is a page of the app: the juicebars at the sidebar's foot (beside a phone's list title) and the palette open it. */
export const usageExtension: DesktopExtension = {
  id: USAGE_EXTENSION_ID,
  name: "Usage",
  activate(plugin) {
    // The window's other machines, read through it; a browser or a phone has none.
    const feed = createLimitsFeed(plugin.host, plugin.environments);
    const choices = createJuicebarChoices();
    const view = createUsageView();
    plugin.registerPage({
      id: USAGE_PAGE,
      label: "Usage",
      description: "What threads cost, counted from each provider's own usage report. Plan usage shows as tokens, not dollars.",
      // A phone draws it as a screen of its own, in one column.
      profiles: ["desktop", "web", "compact"],
      Icon: ChartColumn,
      order: 20,
      layout: "wide",
      keywords: ["cost", "tokens", "limits", "billing"],
      // What is left of each plan, as thin bars at the sidebar's foot; a click opens the limits.
      // Beside them this month's cost (design 1a).
      Summary: (props) => <><Juicebars {...props} feed={feed} choices={choices} /><MonthCost {...props} host={plugin.host} machine={plugin.environments?.shownElsewhere} /></>,
      Component: (props) => <UsagePage {...props} host={plugin.host} environments={plugin.environments} view={view} feed={feed} choices={choices} />,
      // This month, the filters and the sections, in the thread list's place.
      Sidebar: () => <UsageSidebar view={view} />,
    });

    // A phone has no sidebar foot: the bars sit beside its list title; a tablet's foot draws `Summary`.
    plugin.registerRegion({
      id: "usage.juicebars",
      placement: "thread-list-title",
      order: 10,
      profiles: ["compact"],
      Component: (props) => <JuicebarStrip {...props} feed={feed} choices={choices} />,
    });

    // What the plan has left, after the facts under "Runs with" in the model picker; never a mark on a row.
    plugin.registerModelBadge({ id: "usage.plan-left", profiles: ["desktop", "web", "compact"], applies: () => false, label: "Plan", WayLine: createWayLine(feed, choices) });

    plugin.registerCommand({
      id: "usage.open",
      label: "Usage",
      group: "Extensions",
      access: "read",
      run: (app) => app.openPage?.(USAGE_PAGE),
    });
  },
};

export default usageExtension;
