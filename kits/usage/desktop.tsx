import { ChartColumn } from "lucide-react";
import type { DesktopExtension, SettingsPageProps } from "tau";
import { UsagePage } from "./page.js";
import { USAGE_EXTENSION_ID, USAGE_SETTINGS_PAGE } from "./protocol.js";

/** The desktop half of `tau.usage`: one Settings page, and a palette command that opens it. */
export const usageExtension: DesktopExtension = {
  id: USAGE_EXTENSION_ID,
  name: "Usage",
  activate(plugin) {
    plugin.registerSettingsPage({
      id: USAGE_SETTINGS_PAGE,
      label: "Usage",
      profiles: ["desktop"],
      Icon: ChartColumn,
      order: 35,
      Component: (props: SettingsPageProps) => <UsagePage {...props} host={plugin.host} />,
    });

    plugin.registerCommand({
      id: "usage.open",
      label: "Show usage",
      group: "Extensions",
      access: "read",
      run: (app) => app.openSettings(USAGE_SETTINGS_PAGE),
    });
  },
};

export default usageExtension;
