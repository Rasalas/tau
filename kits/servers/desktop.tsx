import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { createServersSettingsPage } from "./settings-page.js";

/** Servers' desktop half: Settings → Servers so far; the server view and status arrive with later tickets. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    return context.registerSettingsPage({
      id: "servers.settings",
      label: "Servers",
      Icon: Server,
      order: 47,
      profiles: ["desktop", "web"],
      keywords: ["sftp", "ftp", "ssh", "sftp.json", "deploy", "profile"],
      Component: createServersSettingsPage(context),
    });
  },
};

export default servers;
