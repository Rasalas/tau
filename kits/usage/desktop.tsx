import { ChartColumn } from "lucide-react";
import type { DesktopExtension, SettingsPageProps } from "tau";
import { UsagePage } from "./page.js";
import { USAGE_EXTENSION_ID, USAGE_SETTINGS_PAGE } from "./protocol.js";

/** Usage opens from the sidebar footer or the command palette. */
export const usageExtension: DesktopExtension = {
  id: USAGE_EXTENSION_ID,
  name: "Usage",
  activate(plugin) {
    plugin.registerSettingsPage({
      id: USAGE_SETTINGS_PAGE,
      label: "Usage",
      standalone: true,
      profiles: ["desktop"],
      Icon: ChartColumn,
      order: 35,
      Component: (props: SettingsPageProps) => <UsagePage {...props} host={plugin.host} />,
    });

    plugin.registerCommand({
      id: "usage.open",
      label: "Usage",
      group: "Extensions",
      surfaces: ["sidebar-footer"],
      Icon: ChartColumn,
      access: "read",
      run: (app) => app.openSettings(USAGE_SETTINGS_PAGE),
    });
  },
};

export default usageExtension;
