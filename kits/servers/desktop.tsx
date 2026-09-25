import { Server } from "lucide-react";
import type { DesktopExtension } from "tau";
import { AskpassQuestions, createAskpassLayer } from "./askpass-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { createServersSettingsPage } from "./settings-page.js";

/** Servers' desktop half: Settings → Servers and the ssh login dialogs; the server view and status arrive with later tickets. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(context) {
    const questions = new AskpassQuestions(context.host);
    const disconnect = questions.connect();
    const releases = [
      context.registerRegion({ id: "servers.askpass", placement: "title-bar", Component: createAskpassLayer(questions) }),
      context.registerSettingsPage({
        id: "servers.settings",
        label: "Servers",
        Icon: Server,
        order: 47,
        profiles: ["desktop", "web"],
        keywords: ["sftp", "ftp", "ssh", "sftp.json", "deploy", "profile"],
        Component: createServersSettingsPage(context),
      }),
    ];
    return () => { for (const release of releases.reverse()) release(); disconnect(); };
  },
};

export default servers;
