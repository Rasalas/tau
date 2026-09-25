import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { createServerProjectSource } from "./project-source.js";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { createServersSettingsPage } from "./settings-page.js";

/** Servers' desktop half: Settings → Servers, the host half's questions and the "From a server…" project source. */
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
      keywords: ["sftp", "ftp", "ssh", "sftp.json", "deploy", "profile", "password", "keychain", "network", "sandbox", "localhost"],
      Component: createServersSettingsPage(context),
    });
    // Workspace Kit's base folder for new projects, when it is there.
    let workspace: { projectBaseDirectory?(): string | undefined } | undefined;
    const stopWorkspace = context.useService<{ projectBaseDirectory?(): string | undefined }>("tau.workspace/store", (store) => {
      workspace = store;
      return () => { if (workspace === store) workspace = undefined; };
    });
    const unregisterSource = context.registerProjectSource({
      id: "servers.from-server",
      label: "From a server…",
      profiles: ["desktop"],
      description: "Download a site over SSH into a new Git project, or give a folder with sftp.json its Git.",
      glyph: "⇣",
      order: 30,
      Component: createServerProjectSource({ host: context.host, baseDirectory: () => workspace?.projectBaseDirectory?.() }),
    });
    return () => { stopFeed(); unregisterLayer(); unregisterPage(); stopWorkspace(); unregisterSource(); };
  },
};

export default servers;
