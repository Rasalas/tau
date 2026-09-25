import type { DesktopExtension } from "tau";
import { AskpassQuestions, createAskpassLayer } from "./askpass-dialog.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

/** Servers' desktop half; the server view, status and Settings → Servers arrive with later tickets. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate(plugin) {
    const questions = new AskpassQuestions(plugin.host);
    const disconnect = questions.connect();
    const releaseLayer = plugin.registerRegion({ id: "servers.askpass", placement: "title-bar", Component: createAskpassLayer(questions) });
    return () => { releaseLayer(); disconnect(); };
  },
};

export default servers;
