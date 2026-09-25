import { GitBranch, Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { DriftFeed, DriftPanel, createDriftGate, driftGateAsks } from "./drift-view.js";
import { ServerPromptFeed, createServerPromptLayer } from "./prompt-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { createServersSettingsPage } from "./settings-page.js";

/** Until the server view has its tabs, drift has a stage tab of its own. */
const DRIFT_TAB = "servers.drift";

/** Servers' desktop half: Settings → Servers, the host half's questions and server drift. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    const feed = new ServerPromptFeed(context);
    const stopFeed = feed.start();
    const drift = new DriftFeed(context);
    const stopDrift = drift.start();
    // Workspace Kit's store knows the open project; the event covers a window without it.
    let workspace: string | undefined;
    let store: { getSnapshot(): { cwd?: string } } | undefined;
    const stopWorkspace = context.events.on("workspace-changed", (event) => { workspace = event.to; });
    const stopStore = context.useService<{ getSnapshot(): { cwd?: string } }>("tau.workspace/store", (service) => {
      store = service;
      return () => { if (store === service) store = undefined; };
    });
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
    const unregisterGate = context.registerComposerGate({
      id: "servers.drift",
      profiles: ["desktop", "web"],
      check: (gate) => driftGateAsks(drift, gate),
      Component: createDriftGate(drift),
    });
    const unregisterTab = context.registerStageTab<{ workspace: string }>({
      kind: DRIFT_TAB,
      profiles: ["desktop", "web"],
      singleton: true,
      title: () => "Server drift",
      Icon: GitBranch,
      render: (params) => <DriftPanel context={context} feed={drift} cwd={params.workspace} />,
      restore: (params) => typeof params.workspace === "string" && Boolean(params.workspace),
    });
    const unregisterCommand = context.registerCommand({
      id: "servers.drift.open",
      label: "Show server drift",
      group: "Servers",
      access: "read",
      run: (actions) => {
        const cwd = store?.getSnapshot().cwd ?? workspace;
        if (cwd) actions.openStageTab(DRIFT_TAB, { workspace: cwd });
        else actions.notify("Open a project first.");
      },
    });
    return () => { stopFeed(); stopDrift(); stopWorkspace(); stopStore(); unregisterLayer(); unregisterPage(); unregisterGate(); unregisterTab(); unregisterCommand(); };
  },
};

export default servers;
