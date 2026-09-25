import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { createServersSettingsPage } from "./settings-page.js";

/** Servers' desktop half: Settings → Servers and the host half's questions; the server view arrives with later tickets. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    const feed = new ServerPromptFeed(context);
    const stopFeed = feed.start();
    const unregisterLayer = context.registerRegion({ id: "servers.prompts", placement: "title-bar", profiles: ["desktop", "web"], Component: createServerPromptLayer(feed) });
    const unregisterPage = context.registerSettingsPage({
      id: "servers.settings",
      label: "Servers",
      Icon: Server,
      order: 47,
      profiles: ["desktop", "web"],
      keywords: ["sftp", "ftp", "ssh", "sftp.json", "deploy", "profile", "password", "keychain"],
      Component: createServersSettingsPage(context),
    });
    return () => { stopFeed(); unregisterLayer(); unregisterPage(); };
  },
};

export default servers;
