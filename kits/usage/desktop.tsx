import { ChartColumn } from "lucide-react";
import type { DesktopExtension } from "tau";
import { UsagePage } from "./page.js";
import { USAGE_EXTENSION_ID, USAGE_PAGE } from "./protocol.js";

/** Usage is a page of the app: the sidebar's foot and the palette open it. */
export const usageExtension: DesktopExtension = {
  id: USAGE_EXTENSION_ID,
  name: "Usage",
  activate(plugin) {
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
      // The window's other machines, read through it; a browser or a phone has none.
      Component: (props) => <UsagePage {...props} host={plugin.host} environments={plugin.environments} />,
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
