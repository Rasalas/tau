import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { SERVERS_SETTINGS_PAGE } from "./view-protocol.js";
import { createServersSettingsPage } from "./settings-page.js";
import { registerServerSurfaces } from "./surfaces.js";

/** Servers' desktop half: the server view and its status, Settings → Servers, and the host half's questions. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    const feed = new ServerPromptFeed(context);
    const stopFeed = feed.start();
    const unregisterLayer = context.registerRegion({ id: "servers.prompts", placement: "title-bar", profiles: ["desktop", "web"], Component: createServerPromptLayer(feed) });
    const unregisterPage = context.registerSettingsPage({
      id: SERVERS_SETTINGS_PAGE,
      label: "Servers",
      Icon: Server,
      order: 47,
      profiles: ["desktop", "web"],
      keywords: ["sftp", "ftp", "ssh", "sftp.json", "deploy", "profile", "password", "keychain", "network", "sandbox", "localhost"],
      Component: createServersSettingsPage(context),
    });
    const unregisterSurfaces = registerServerSurfaces(context);
    return () => { unregisterSurfaces(); stopFeed(); unregisterLayer(); unregisterPage(); };
  },
};

export default servers;
