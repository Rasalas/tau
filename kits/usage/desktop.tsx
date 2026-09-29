import { ChartColumn } from "lucide-react";
import type { DesktopExtension } from "tau";
import { UsageSidebar } from "./controls.js";
import { createUsageView } from "./filters.js";
import { JuicebarStrip } from "./juicebar-strip.js";
import { createJuicebarChoices } from "./juicebars.js";
import { Juicebars } from "./juicebars-view.js";
import { createLimitsFeed } from "./limits-feed.js";
import { UsagePage } from "./page.js";
import { USAGE_EXTENSION_ID, USAGE_PAGE } from "./protocol.js";

/** Usage is a page of the app: the juicebars at the sidebar's foot (a phone's list's top) and the palette open it. */
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
      description: "What your threads used, from each runtime's own records, and how much of each plan is left.",
      // A phone draws it as a screen of its own, in one column.
      profiles: ["desktop", "web", "compact"],
      Icon: ChartColumn,
      order: 20,
      layout: "wide",
      keywords: ["cost", "tokens", "limits", "billing"],
      // What is left of each plan, as thin bars at the sidebar's foot; a click opens the limits.
      Summary: (props) => <Juicebars {...props} feed={feed} choices={choices} />,
      Component: (props) => <UsagePage {...props} host={plugin.host} environments={plugin.environments} view={view} feed={feed} choices={choices} />,
      // This month, the filters and the sections, in the thread list's place.
      Sidebar: () => <UsageSidebar view={view} />,
    });

    // A phone has no sidebar foot: the bars top its thread list instead (K106).
    plugin.registerRegion({
      id: "usage.juicebars",
      placement: "thread-list-head",
      order: 10,
      profiles: ["compact"],
      Component: (props) => <JuicebarStrip {...props} feed={feed} choices={choices} />,
    });

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
