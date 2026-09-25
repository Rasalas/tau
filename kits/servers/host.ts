import type { HostExtension } from "tau/host-extension";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { ServerSsh } from "./ssh-service.js";

/**
 * Servers: a server reached over SSH/SFTP or FTP as a project's work target
 * (ADR 0028). The agent works on the local copy; the user deploys by hand.
 */
export function createServersHostExtension(): HostExtension {
  return {
    id: SERVERS_EXTENSION_ID,
    name: "Servers",
    permissions: ["process", "network", "sessions", "runtime:extend", "workspace:read"],
    isolation: "in-process",
    activate(context) {
      const ssh = new ServerSsh(context);
      ssh.register();
      return () => ssh.dispose();
    },
  };
}

export default createServersHostExtension;
