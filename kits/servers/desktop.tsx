import type { DesktopExtension } from "tau";
import { SERVERS_EXTENSION_ID } from "./protocol.js";

/** Servers' desktop half; the server view, status and Settings → Servers arrive with later tickets. */
const servers: DesktopExtension = {
  id: SERVERS_EXTENSION_ID,
  name: "Servers",
  activate() {
    return undefined;
  },
};

export default servers;
