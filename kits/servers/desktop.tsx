import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { createServerProjectSource } from "./project-source.js";
import { DriftFeed, createDriftGate, driftGateAsks } from "./drift-view.js";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { SERVERS_SETTINGS_PAGE } from "./view-protocol.js";
import { createServersSettingsPage } from "./settings-page.js";
import { registerServerSurfaces } from "./surfaces.js";

/** Servers' desktop half: the server view and its status, server drift, the "From a server…" project source, Settings → Servers and the host half's questions. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    const feed = new ServerPromptFeed(context);
    const stopFeed = feed.start();
    const drift = new DriftFeed(context);
    const stopDrift = drift.start();
    let store: { projectBaseDirectory?(): string | undefined } | undefined;
    const stopStore = context.useService<{ projectBaseDirectory?(): string | undefined }>("tau.workspace/store", (service) => {
      store = service;
      return () => { if (store === service) store = undefined; };
    });
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
    const unregisterGate = context.registerComposerGate({
      id: "servers.drift",
      profiles: ["desktop", "web"],
      check: (gate) => driftGateAsks(drift, gate),
      Component: createDriftGate(drift),
    });
    const unregisterSource = context.registerProjectSource({
      id: "servers.from-server",
      label: "From a server…",
      profiles: ["desktop"],
      description: "Download a site over SSH into a new Git project, or give a folder with sftp.json its Git.",
      glyph: "⇣",
      order: 30,
      // Workspace Kit's base folder for new projects, when it is there.
      Component: createServerProjectSource({ host: context.host, baseDirectory: () => store?.projectBaseDirectory?.() }),
    });
    const unregisterSurfaces = registerServerSurfaces(context, drift);
    return () => { unregisterSurfaces(); unregisterSource(); unregisterGate(); stopStore(); stopFeed(); stopDrift(); unregisterLayer(); unregisterPage(); };
  },
};

export default servers;
