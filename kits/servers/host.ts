import type { HostExtension } from "tau/host-extension";
import { ServerCredentials, registerCredentialCommands } from "./credentials.js";
import { ServerPrompts } from "./prompts.js";
import { SERVERS_EXTENSION_ID } from "./protocol.js";
import { ServersStore } from "./store.js";
import { ServerTargets } from "./targets.js";

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
      const { services } = context;
      const logger = { warn: (message: string) => services.log("servers.store", message) };
      const store = new ServersStore(services.stateDir, logger);
      const targets = new ServerTargets({ services, store });
      targets.register(context);
      const prompts = new ServerPrompts((event, payload) => context.emit(event, payload));
      const credentials = new ServerCredentials({
        prompts,
        targetsDir: store.targetsDir,
        findCommand: (name) => services.findCommand(name),
        logger,
        log: (event, message) => services.log(event, message),
      });
      registerCredentialCommands(context, credentials, prompts, (cwd, targetId) => targets.target(cwd, targetId), (cwd) => targets.list(cwd));
      return () => prompts.dispose();
    },
  };
}

export default createServersHostExtension;
